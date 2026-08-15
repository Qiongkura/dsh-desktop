'use strict'

/**
 * DeepSeek Harness Desktop — Electron 主进程。
 *
 * 职责：
 *  1. 解析后端运行时与端口：
 *     - 优先级：DSH_ROOT 环境变量 / --dsh-root 参数（外部仓库）
 *             > 应用内置运行时（resources/runtime，自包含发行版）
 *             > 配置文件 > 默认仓库路径 G:\deepseek-harness；
 *  2. 探测本地 Web GUI：已在运行则直接接管，否则启动后端进程
 *     （内置运行时用内置 node.exe + @deepseek-ai/dsh 的 lib/bin.js）；
 *  3. 用原生 BrowserWindow 加载 GUI，管理进程生命周期；
 *  4. 点 × 时弹出 DSH 风格询问（隐藏到系统托盘 / 直接退出），
 *     隐藏到托盘后应用与后端继续后台运行，可从托盘图标恢复。
 *
 * 命令行参数：
 *  --dsh-root=<path>   指定 DSH 仓库根目录（外部模式）
 *  --port=<n>          指定后端端口（默认 3080）
 *  --no-server         只接管已运行的服务，绝不自己启动后端
 *  --no-tray           禁用托盘与关闭询问（点 × 直接退出，恢复旧行为）
 *  --smoke-test        加载完成后打印 SMOKE_OK/SMOKE_FAIL 并退出（自动化验证用）
 */

const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } = require('electron')
const { spawn, execFile, execFileSync } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const APP_NAME = 'DeepSeek Harness Desktop'
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3080
const DEFAULT_DSH_ROOT = 'G:\\deepseek-harness'
const DEFAULT_DSH_HOME = path.join(os.homedir(), '.dsh')

// ---------------------------------------------------------------- 日志 ----

function logFile(name) {
  return path.join(app.getPath('userData'), 'logs', name)
}

function writeLog(name, text) {
  try {
    fs.mkdirSync(path.dirname(logFile(name)), { recursive: true })
    fs.appendFileSync(logFile(name), text)
  } catch { /* 日志失败不影响主流程 */ }
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`
  process.stdout.write(line)
  writeLog('main.log', line)
}

// ---------------------------------------------------------------- 配置 ----

function configPath() {
  return path.join(app.getPath('userData'), 'config.json')
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8'))
  } catch {
    return {}
  }
}

function saveConfig(patch) {
  try {
    const next = { ...loadConfig(), ...patch }
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2))
  } catch (error) {
    log('config save failed:', String(error))
  }
}

function argvValue(flag) {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`))
  return hit === undefined ? undefined : hit.slice(flag.length + 1)
}

/** 显式指定的外部 DSH 仓库根目录（env / 命令行参数），没有则返回 null。 */
function explicitDshRoot() {
  const candidate = process.env.DSH_ROOT ?? argvValue('--dsh-root')
  if (candidate && fs.existsSync(path.join(candidate, 'apps', 'cli', 'src', 'bin.ts'))) {
    return path.resolve(candidate)
  }
  return null
}

/** 应用内置运行时（自包含发行版）：resources/runtime 根即 @deepseek-ai/dsh 部署包。 */
function bundledRuntimeRoot() {
  const candidate = path.join(process.resourcesPath ?? '', 'runtime')
  if (fs.existsSync(path.join(candidate, 'lib', 'bin.js'))) {
    return candidate
  }
  return null
}

/** 外部仓库：配置文件 > 默认路径。 */
function configuredDshRoot() {
  const cfg = loadConfig()
  for (const candidate of [cfg.dshRoot, DEFAULT_DSH_ROOT]) {
    if (candidate && fs.existsSync(path.join(candidate, 'apps', 'cli', 'src', 'bin.ts'))) {
      return path.resolve(candidate)
    }
  }
  return null
}

/**
 * 解析后端运行时。
 * @returns {{root: string, bundled: boolean, entry: string}} entry 为相对 root 的后端入口
 */
function resolveRuntime() {
  const external = explicitDshRoot()
  if (external !== null) {
    return { root: external, bundled: false, entry: path.join('apps', 'cli', 'src', 'bin.ts') }
  }
  const bundled = bundledRuntimeRoot()
  if (bundled !== null) {
    return { root: bundled, bundled: true, entry: path.join('lib', 'bin.js') }
  }
  const configured = configuredDshRoot()
  if (configured !== null) {
    return { root: configured, bundled: false, entry: path.join('apps', 'cli', 'src', 'bin.ts') }
  }
  return null
}

/** 解析端口。 */
function resolvePort() {
  const raw = process.env.DSH_PORT ?? argvValue('--port') ?? loadConfig().port ?? DEFAULT_PORT
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : DEFAULT_PORT
}

// ---------------------------------------------------------------- 网络 ----

/** 探测 URL 是否已可访问（任何 HTTP 响应都算活着）。 */
function probe(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

function waitForUrl(url, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = async () => {
      if (await probe(url)) return resolve(true)
      if (Date.now() >= deadline) return resolve(false)
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

// ---------------------------------------------------------------- 后端 ----

let serverChild = null
let serverExternal = false
let quitting = false
let intentionalKill = false

/** 启动后端进程（`dsh web`）。runtime 由 resolveRuntime() 返回。 */
function startServer(runtime, port) {
  const packagedNode = path.join(process.resourcesPath ?? '', 'node.exe')
  const nodeBin = process.env.DSH_NODE
    ?? (fs.existsSync(packagedNode) ? packagedNode : 'node')
  const entry = path.join(runtime.root, runtime.entry)
  const args = runtime.bundled
    ? [entry, 'web', '--host', DEFAULT_HOST, '--port', String(port)]
    : ['--import', 'tsx/esm', entry, 'web', '--host', DEFAULT_HOST, '--port', String(port)]
  // 内置模式把 DSH_HOME 隔离到应用自己的数据目录，不碰用户本机的 ~/.dsh
  const dshHome = runtime.bundled
    ? path.join(app.getPath('userData'), 'home')
    : (process.env.DSH_HOME ?? DEFAULT_DSH_HOME)
  const env = { ...process.env, DSH_HOME: dshHome }
  log(`spawning backend: ${nodeBin} ${args.join(' ')} (cwd=${runtime.root}, DSH_HOME=${dshHome})`)
  const child = spawn(nodeBin, args, {
    cwd: runtime.root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { process.stdout.write(chunk); writeLog('dsh-web.out.log', chunk) })
  child.stderr.on('data', (chunk) => { process.stderr.write(chunk); writeLog('dsh-web.err.log', chunk) })
  child.on('error', (error) => {
    log('backend spawn error:', String(error))
    if (!quitting) {
      dialog.showErrorBox(APP_NAME,
        `无法启动 DSH 后端：${error.message}\n\n请确认已安装 Node.js（或设置 DSH_NODE 指向 node.exe）。`)
      app.quit()
    }
  })
  child.on('exit', (code, signal) => {
    log(`backend exited: code=${code} signal=${String(signal)}`)
    serverChild = null
    // 主动终止（退出/冒烟测试）不视为意外退出；只有自己拉起的后端崩溃才处理
    if (!quitting && !serverExternal && !intentionalKill) {
      // 常见原因是端口被本机其他 GUI 服务抢占（EADDRINUSE）：先探测端口，
      // 若已有服务在响应就转为挂接模式继续用，而不是退出
      const url = `http://${DEFAULT_HOST}:${port}`
      probe(url).then((alive) => {
        if (alive) {
          log('port taken over by another server, attaching (server not owned by this app)')
          serverExternal = true
        } else {
          dialog.showErrorBox(APP_NAME,
            `DSH 后端进程意外退出（code=${code}）。\n日志：${logFile('dsh-web.err.log')}`)
          app.quit()
        }
      })
    }
  })
  return child
}

/** 杀掉后端进程树（Windows 用 taskkill /T 确保子进程一并回收）。 */
function killServer(sync = false) {
  if (serverChild === null || serverChild.exitCode !== null) return
  const pid = serverChild.pid
  log(`killing backend pid=${pid}`)
  intentionalKill = true
  try { serverChild.kill() } catch { /* ignore */ }
  try {
    if (sync) {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } else {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- 壁纸 ----

/** 解析壁纸路径（env > 命令行 > 配置文件），文件不存在返回 null。 */
function resolveWallpaper() {
  const cfg = loadConfig()
  const candidate = process.env.DSH_WALLPAPER ?? argvValue('--wallpaper') ?? cfg.wallpaper
  if (candidate && fs.existsSync(candidate)) return path.resolve(candidate)
  return null
}

/** 把壁纸图片转成 data: URL（http 页面不能加载 file:// 资源）。
 *  大图（手机原图可达数十 MB）会拖死渲染器（解码 + 全屏毛玻璃逐帧重采样），
 *  因此用 nativeImage 缩放到最长边 3840px 后再编码（4K 屏满清晰度；
 *  之前的 1920px 在 4K 屏上被拉伸 2 倍导致看起来模糊）。 */
function wallpaperDataUrl(file) {
  const ext = path.extname(file).toLowerCase()
  const mime = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  }[ext] || 'image/png'
  try {
    const img = nativeImage.createFromPath(file)
    if (!img.isEmpty()) {
      const { width } = img.getSize()
      const MAX = 3840
      const resized = width > MAX ? img.resize({ width: MAX }) : img
      const buf = ext === '.png' ? resized.toPNG() : resized.toJPEG(92)
      return `data:${mime};base64,${buf.toString('base64')}`
    }
  } catch { /* 回退到原文件 */ }
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
}

/** 生成启动画面（加载 GUI 前显示壁纸），写入 userData 后 loadFile。 */
function showSplash(win, wallpaper) {
  const dataUrl = wallpaperDataUrl(wallpaper)
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#101318}
    .wall{position:fixed;inset:0;background:url('${dataUrl}') center/cover no-repeat}
    .shade{position:fixed;inset:0;background:linear-gradient(to top,rgba(8,10,16,.55),transparent 45%)}
    .brand{position:fixed;left:28px;bottom:22px;color:#fff;font:600 20px/1.3 "Segoe UI",system-ui,sans-serif;opacity:.92}
    .brand small{display:block;font:400 12px/1.4 "Segoe UI",system-ui,sans-serif;opacity:.65}
  </style></head><body>
    <div class="wall"></div><div class="shade"></div>
    <div class="brand">DeepSeek Harness<small>正在启动本地服务…</small></div>
  </body></html>`
  const splash = path.join(app.getPath('userData'), 'splash.html')
  try {
    fs.writeFileSync(splash, html)
    win.loadFile(splash)
  } catch { /* 壁纸失败不阻塞启动 */ }
}

/** 当前壁纸模糊值（px），来自配置，默认 18。 */
function wallpaperBlur() {
  const n = Number(loadConfig().wallpaperBlur)
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 18
}

/** 代码块透明度（0.08-1），来自配置，默认 0.45。 */
function wallpaperCodeAlpha() {
  const n = Number(loadConfig().wallpaperCodeAlpha)
  return Number.isFinite(n) ? Math.max(0.08, Math.min(1, n)) : 0.45
}

/** 已注入的面板 CSS key（用于清除壁纸时移除）；壁纸层是 JS 创建的 div，可即时换图。 */
let wallpaperCssKey = null

/** 注入壁纸 CSS（幂等）。壁纸完全用 CSS 实现：body 的 ::before/::after 伪元素
 *  作为最底层背景（负 z-index + 不接收指针事件），模糊用 filter 模糊自身背景副本；
 *  不创建任何 JS 层、不设 ResizeObserver、不碰布局——不可能拦截输入或盖住界面。 */
function injectWallpaperCss(win) {
  if (wallpaperCssKey !== null) return wallpaperCssKey
  const css = `
    html { background: transparent !important; }
    body { background: transparent !important; }
    body::before, body::after {
      content: '' !important;
      position: fixed !important;
      top: 0 !important;
      height: 100vh !important;
      z-index: -1 !important;
      pointer-events: none !important;
      background-position: center !important;
      background-size: cover !important;
      background-repeat: no-repeat !important;
    }
    /* 全窗：标准模糊，主壁纸 */
    body::before {
      left: 0 !important;
      right: 0 !important;
      background-image: var(--dsh-wallpaper-url) !important;
      filter: blur(var(--dsh-wallpaper-blur, 18px)) !important;
    }
    /* 左侧栏区域：共用模式不渲染这层（主区壁纸本身就覆盖侧栏，再叠一层
       会在右边缘产生模糊采样接缝）；只有单独设置侧栏独立图时才显示 */
    body::after {
      left: 0 !important;
      width: var(--dsh-sidebar-w, 280px) !important;
      background-image: var(--dsh-wallpaper-url-sidebar, none) !important;
      background-attachment: var(--dsh-sidebar-attachment, fixed) !important;
      /* 与主区同模糊度 */
      filter: blur(var(--dsh-wallpaper-blur, 18px)) !important;
    }
    #root [data-slot='root'] > div,
    #root [data-slot='root'] > div > div { background: transparent !important; }
    #root [data-slot='root'] > div > div > [data-slot] > div {
      background: var(--dsh-wallpaper-panel, rgba(255,255,255,0.55)) !important;
    }
    /* 侧栏面板独立透明开关：--dsh-wallpaper-panel-sidebar 由 applyVars 控制 */
    #root [data-slot='root'] > div > div:first-child > [data-slot] > div {
      background: var(--dsh-wallpaper-panel-sidebar, var(--dsh-wallpaper-panel, rgba(255,255,255,0.55))) !important;
    }
    /* 输入框区域：座位本身透明；::before 铺一层与主区视口对齐的壁纸
       （不透明），滚到输入框下方的聊天文字被完全盖住不显示，
       壁纸保持连续；伪元素滤镜只模糊自身，不影响输入内容。
       遮罩向上延伸 44px（盖到座位上方滚动区）：文字在输入卡片上方
       就渐隐完毕，卡片区域全程不透明，绝不会和文字重叠。
       主界面不透明时 --dsh-t-composer-mask-url=none 撤销这层壁纸 */
    #root [class*='composerSeat'] {
      background: transparent !important;
    }
    #root [class*='composerSeat']::before {
      content: '' !important;
      position: absolute !important;
      inset: -44px 0 0 0 !important;
      z-index: -1 !important;
      pointer-events: none !important;
      background-image: var(--dsh-t-composer-mask-url, var(--dsh-wallpaper-url)) !important;
      background-position: center !important;
      background-size: cover !important;
      background-repeat: no-repeat !important;
      background-attachment: fixed !important;
      filter: blur(var(--dsh-wallpaper-blur, 18px)) !important;
      /* 顶部 44px 渐入（在座位上方）：文字在卡片上方逐渐隐去，
         壁纸边缘与主区自然衔接，不生硬截断 */
      -webkit-mask-image: linear-gradient(to bottom, transparent 0px, black 44px) !important;
      mask-image: linear-gradient(to bottom, transparent 0px, black 44px) !important;
    }
    /* 侧栏底部：把原 24px 主题渐隐层改为壁纸遮挡层——
       会话列表滚到底部时，文字在顶部 32px 渐变区渐隐，
       下方被不透明壁纸盖住（与输入框同款遮挡+渐变） */
    #root [data-slot='root'] > div > div:first-child [class$='treeBody'] [class$='fade'] {
      height: 72px !important;
      pointer-events: none !important;
      background-image: var(--dsh-wallpaper-url-sidebar, var(--dsh-wallpaper-url)) !important;
      background-position: center !important;
      background-size: cover !important;
      background-repeat: no-repeat !important;
      background-attachment: var(--dsh-sidebar-attachment, fixed) !important;
      filter: blur(var(--dsh-wallpaper-blur, 18px)) !important;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0px, black 32px) !important;
      mask-image: linear-gradient(to bottom, transparent 0px, black 32px) !important;
    }
    /* 侧栏"新对话"按钮：透明开关由 --dsh-t-new-session 控制 */
    #root [class*='newSession'] {
      background: var(--dsh-t-new-session, transparent) !important;
    }`
  wallpaperCssKey = win.webContents.insertCSS(css)
  wallpaperCssKey.catch(() => { wallpaperCssKey = null })
  return wallpaperCssKey
}

/** 应用壁纸：把图片 data URL 写入 CSS 变量（body::before/::after 即时生效）。 */
function setWallpaperLayer(win, dataUrl) {
  return win.webContents.executeJavaScript(`(() => {
    document.body.style.setProperty('--dsh-wallpaper-url', "url('${dataUrl}')")
    const frame = document.querySelector('#root [data-slot="root"] > div')
    const first = frame ? frame.children[0] : null
    if (first) {
      document.body.style.setProperty('--dsh-sidebar-w', first.getBoundingClientRect().width + 'px')
    }
    return document.body.style.getPropertyValue('--dsh-wallpaper-url').slice(0, 40)
  })()`)
}

/** 设置/清除侧栏独立壁纸（dataUrl 为 null 时清除，侧栏回落共用主壁纸）。 */
function setSidebarWallpaperLayer(win, dataUrl) {
  const expr = dataUrl === null
    ? `document.body.style.removeProperty('--dsh-wallpaper-url-sidebar');
       document.body.style.removeProperty('--dsh-sidebar-attachment');
       return '(cleared)'`
    : `document.body.style.setProperty('--dsh-wallpaper-url-sidebar', "url('${dataUrl}')");
       document.body.style.setProperty('--dsh-sidebar-attachment', 'scroll');
       return document.body.style.getPropertyValue('--dsh-wallpaper-url-sidebar').slice(0, 40)`
  return win.webContents.executeJavaScript(`(() => { ${expr} })()`)
}

/** 当前侧栏壁纸路径（配置，未单独设置时为 null）。 */
function configuredSidebarWallpaper() {
  const cfg = loadConfig()
  const candidate = cfg.sidebarWallpaper
  if (candidate && fs.existsSync(candidate)) return path.resolve(candidate)
  return null
}

/** 启动时应用侧栏壁纸（未单独设置则无操作，共用主壁纸）。 */
function applySidebarWallpaper(win) {
  const file = configuredSidebarWallpaper()
  if (file === null) return
  setSidebarWallpaperLayer(win, wallpaperDataUrl(file))
    .catch((error) => log('sidebar wallpaper failed:', String(error)))
}

/** 各区域透明开关（配置，默认全开）。 */
function transparentFlags() {
  const cfg = loadConfig()
  return {
    newSession: cfg.transparentNewSession !== false,
    input: cfg.transparentInput !== false,
    sidebar: cfg.transparentSidebar !== false,
    main: cfg.transparentMain !== false,
  }
}

/** 页面加载后应用壁纸：只做一次性 CSS 变量设置 + 写入壁纸 data URL。
 *  无 MutationObserver、无监听器、无探针 —— 全部是一次性赋值；
 *  代码块透明度/区域透明开关由 __dshApplyWallpaperVars() 按需手动重应用（对话框调用）。 */
function applyWallpaper(win, wallpaper) {
  injectWallpaperCss(win)
  const dataUrl = wallpaperDataUrl(wallpaper)
  win.webContents.executeJavaScript(`(() => {
    const scheme = getComputedStyle(document.documentElement).colorScheme || 'light'
    const dark = scheme === 'dark'
    window.__dshWallpaperTransparent = ${JSON.stringify(transparentFlags())}
    document.documentElement.style.setProperty('--dsh-wallpaper-blur', '${wallpaperBlur()}px')
    document.documentElement.style.setProperty('--dsh-wallpaper-code-alpha', '${wallpaperCodeAlpha()}')
    const applyVars = () => {
      const isDark = document.body.hasAttribute('data-ds-dark-theme')
        || (getComputedStyle(document.documentElement).colorScheme || 'light') === 'dark'
      const T = window.__dshWallpaperTransparent || { newSession: true, input: true, sidebar: true, main: true }
      const a = parseFloat(document.documentElement.style.getPropertyValue('--dsh-wallpaper-code-alpha'))
      const alpha = Number.isFinite(a) ? Math.max(0.08, Math.min(1, a)) : 0.45
      const panelColor = isDark ? 'rgba(12,15,22,0.58)' : 'rgba(255,255,255,0.55)'
      // 主界面面板：透明=半透明面板色；不透明=主题基底色
      document.documentElement.style.setProperty('--dsh-wallpaper-panel',
        T.main ? panelColor : 'var(--dsw-alias-bg-base)')
      // 侧栏面板：独立开关
      document.documentElement.style.setProperty('--dsh-wallpaper-panel-sidebar',
        T.sidebar ? panelColor
          : (isDark ? 'var(--dsw-static-neutral-bluish-900)' : 'var(--dsw-static-neutral-bluish-50)'))
      // 面板前景（标题栏文字/边框/悬停）：跟随外观明暗，与面板色同源
      document.documentElement.style.setProperty('--dsh-wallpaper-panel-fg',
        isDark ? 'rgba(249,250,251,0.92)' : 'rgba(15,17,21,0.92)')
      document.documentElement.style.setProperty('--dsh-wallpaper-panel-border',
        isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)')
      document.documentElement.style.setProperty('--dsh-wallpaper-panel-hover',
        isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)')
      // 输入框卡片（含"新会话"英雄卡片）
      document.body.style.setProperty('--dsw-specific-input-major',
        T.input ? 'transparent'
          : (isDark ? 'var(--dsw-static-neutral-bluish-850)' : 'var(--dsw-static-neutral-bluish-00)'))
      // 侧栏"新对话"按钮
      document.documentElement.style.setProperty('--dsh-t-new-session',
        T.newSession ? 'transparent' : 'var(--dsw-alias-button-elevated-fill)')
      // 输入框下方的壁纸遮罩（盖住滚动文字）：主界面不透明时撤销
      if (T.main) document.documentElement.style.removeProperty('--dsh-t-composer-mask-url')
      else document.documentElement.style.setProperty('--dsh-t-composer-mask-url', 'none')
      // 侧栏滚动渐隐终点色：保持透明（让背景透出），不随开关恢复
      document.body.style.setProperty('--dsw-specific-sidebar-fill', 'transparent')
      // 代码块/行内代码透明度
      document.body.style.setProperty('--dsw-alias-markdown-code-block',
        isDark ? 'rgba(12,15,22,' + alpha + ')' : 'rgba(255,255,255,' + alpha + ')')
      document.body.style.setProperty('--dsw-alias-markdown-code-block-banner',
        isDark ? 'rgba(20,24,34,' + alpha + ')' : 'rgba(250,251,252,' + alpha + ')')
      document.body.style.setProperty('--dsw-alias-markdown-inline-code',
        isDark ? 'rgba(35,38,43,' + alpha + ')' : 'rgba(239,240,243,' + alpha + ')')
    }
    applyVars()
    window.__dshApplyWallpaperVars = applyVars
    window.__dshWallpaperCleanup = () => {
      document.body.style.removeProperty('--dsh-wallpaper-url')
      document.body.style.removeProperty('--dsh-sidebar-w')
      document.body.style.removeProperty('--dsw-alias-markdown-code-block')
      document.body.style.removeProperty('--dsw-alias-markdown-code-block-banner')
      document.body.style.removeProperty('--dsw-alias-markdown-inline-code')
      document.body.style.removeProperty('--dsw-specific-sidebar-fill')
      document.body.style.removeProperty('--dsw-specific-input-major')
      document.documentElement.style.removeProperty('--dsh-wallpaper-panel')
      document.documentElement.style.removeProperty('--dsh-wallpaper-panel-sidebar')
      document.documentElement.style.removeProperty('--dsh-wallpaper-panel-fg')
      document.documentElement.style.removeProperty('--dsh-wallpaper-panel-border')
      document.documentElement.style.removeProperty('--dsh-wallpaper-panel-hover')
      document.documentElement.style.removeProperty('--dsh-wallpaper-blur')
      document.documentElement.style.removeProperty('--dsh-wallpaper-code-alpha')
      document.documentElement.style.removeProperty('--dsh-t-new-session')
      document.documentElement.style.removeProperty('--dsh-t-composer-mask-url')
    }
    return JSON.stringify({ scheme, blur: ${wallpaperBlur()}, codeAlpha: ${wallpaperCodeAlpha()}, transparent: ${JSON.stringify(transparentFlags())} })
  })()`).then((state) => {
    log('wallpaper applied: ' + state)
  }).catch((error) => log('wallpaper scheme detection failed:', String(error)))
  setWallpaperLayer(win, dataUrl).catch((error) => log('wallpaper layer failed:', String(error)))
}

/** 文件菜单：选择壁纸图片，立即生效（不重载页面）。 */
async function pickWallpaper() {
  const win = mainWindow
  if (win === null || win.isDestroyed()) return
  const result = await dialog.showOpenDialog(win, {
    title: '选择壁纸图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return
  const file = result.filePaths[0]
  saveConfig({ wallpaper: file })
  log(`wallpaper set: ${file}`)
  try {
    await setWallpaperLayer(win, wallpaperDataUrl(file))
    log('wallpaper updated live')
  } catch (error) {
    log('wallpaper live update failed:', String(error))
  }
}

/** 文件菜单：清除壁纸，立即生效（不重载页面）。 */
async function clearWallpaper() {
  saveConfig({ wallpaper: undefined })
  log('wallpaper cleared')
  const win = mainWindow
  if (win === null || win.isDestroyed()) return
  try {
    await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('dsh-wallpaper-layer')
      if (el) el.style.display = 'none'
      if (typeof window.__dshWallpaperCleanup === 'function') window.__dshWallpaperCleanup()
      return !!el
    })()`)
    if (wallpaperCssKey !== null) {
      win.webContents.removeInsertedCSS(wallpaperCssKey).catch(() => {})
      wallpaperCssKey = null
    }
    log('wallpaper removed live')
  } catch (error) {
    log('wallpaper clear failed:', String(error))
  }
}

/** 把模糊值写到主窗口的 CSS 变量（实时预览用）。 */
function setWallpaperBlurVar(value) {
  const win = mainWindow
  if (win === null || win.isDestroyed()) return
  const v = Math.max(0, Math.min(100, Number(value) || 0))
  win.webContents.executeJavaScript(
    `document.documentElement.style.setProperty('--dsh-wallpaper-blur', '${v}px')`,
  ).catch(() => {})
}

/** 把代码块透明度写到页面（实时预览用，手动重应用，无观察器）。 */
function setCodeAlphaVar(value) {
  const win = mainWindow
  if (win === null || win.isDestroyed()) return
  const a = Math.max(0.08, Math.min(1, Number(value) || 0.45))
  win.webContents.executeJavaScript(
    `document.documentElement.style.setProperty('--dsh-wallpaper-code-alpha', '${a}');
     if (typeof window.__dshApplyWallpaperVars === 'function') window.__dshApplyWallpaperVars()`,
  ).catch(() => {})
}

/** 当前壁纸路径（配置，可能为 null）。 */
function configuredWallpaper() {
  const cfg = loadConfig()
  const candidate = cfg.wallpaper
  if (candidate && fs.existsSync(candidate)) return path.resolve(candidate)
  return null
}

/** 构建壁纸设置对话框的 HTML（跟随主窗口亮/暗主题）。
 *  @param blur 当前模糊值；@param codeAlpha 当前代码块透明度；@param image 当前壁纸路径或 null；
 *  @param sidebarImage 侧栏独立壁纸路径或 null（null = 共用主壁纸）；
 *  @param flags 各区域透明开关 {newSession,input,sidebar,main}；
 *  @param dark 是否深色主题（false = 浅色） */
function buildWallpaperDialogHtml(blur, codeAlpha, image, sidebarImage, flags, dark = true) {
  const imageName = image === null ? '（无）' : path.basename(image)
  const sidebarName = sidebarImage === null ? '（无）' : path.basename(sidebarImage)
  const alphaPct = Math.round(codeAlpha * 100)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>界面设置</title>
<style>
  :root {
    --bg-base: ${dark ? '#151517' : '#f6f7f9'};
    --border-l2: ${dark ? 'rgba(255,255,255,0.12)' : 'rgba(15,17,21,0.14)'};
    --hover-bg: ${dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,17,21,0.06)'};
    --label-primary: ${dark ? '#f9fafb' : '#0f1115'};
    --label-secondary: ${dark ? '#81858c' : '#61666b'};
    --label-tertiary: ${dark ? '#6b6f76' : '#81858c'};
    --accent: #4d6bfe;
    --btn-primary-bg: ${dark ? '#f9fafb' : '#0f1115'};
    --btn-primary-fg: ${dark ? '#0f1115' : '#f9fafb'};
    --btn-primary-hover: ${dark ? '#ebecf2' : '#2a2e37'};
  }
  * { margin: 0; padding: 0; box-sizing: border-box; user-select: none; }
  html, body { height: 100%; }
  body {
    color-scheme: ${dark ? 'dark' : 'light'};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
    background: var(--bg-base); color: var(--label-primary); overflow: hidden;
  }
  .card {
    height: 100%; display: flex; flex-direction: column;
    background: var(--bg-base);
    overflow: hidden;
  }
  .body { padding: 18px 20px 0; }
  .title { font-size: 14px; line-height: 20px; font-weight: 600; }
  .desc { margin-top: 4px; font-size: 12px; line-height: 18px; color: var(--label-secondary); }
  .row { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
  .row .label { width: 92px; font-size: 12px; color: var(--label-secondary); flex: none; }
  .imgrow { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
  .imgname { flex: 1; font-size: 12px; color: var(--label-primary);
             white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  input[type=range] { flex: 1; accent-color: var(--accent); height: 4px; min-width: 0; }
  .val { min-width: 52px; text-align: right; font-size: 13px; color: var(--label-primary);
         font-variant-numeric: tabular-nums; }
  .smallbtn {
    height: 26px; padding: 0 12px; border-radius: 13px; border: 1px solid var(--border-l2);
    background: transparent; color: var(--label-primary); font-size: 12px; font-family: inherit;
    cursor: pointer; flex: none;
  }
  .smallbtn:hover { background: var(--hover-bg); }
  .seg { display: flex; gap: 6px; flex: 1; min-width: 0; }
  .segbtn {
    height: 26px; padding: 0 8px; border-radius: 13px; border: 1px solid var(--border-l2);
    background: transparent; color: var(--label-secondary); font-size: 12px; font-family: inherit;
    cursor: pointer; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .segbtn.on { background: rgba(77,107,254,.18); border-color: var(--accent); color: var(--accent); }
  .segbtn:hover { background: var(--hover-bg); }
  .segbtn.on:hover { background: rgba(77,107,254,.26); }
  .checks { display: flex; flex-wrap: wrap; gap: 6px 14px; flex: 1; min-width: 0; }
  .check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px;
           color: var(--label-secondary); cursor: pointer; white-space: nowrap; }
  .check input { accent-color: var(--accent); width: 13px; height: 13px; margin: 0; cursor: pointer; }
  .footer { margin-top: auto; display: flex; justify-content: flex-end; align-items: center;
            gap: 10px; padding: 16px 20px 18px; }
  .btn {
    height: 32px; padding: 0 16px; border-radius: 16px; border: 1px solid transparent;
    background: transparent; color: var(--label-primary); font-size: 12px; font-weight: 500;
    font-family: inherit; cursor: pointer; transition: background-color .12s ease, border-color .12s ease;
  }
  .btn:focus-visible { outline: 2px solid rgba(86,134,254,.6); outline-offset: 1px; }
  .btn-ghost { border-color: var(--border-l2); }
  .btn-ghost:hover { background: var(--hover-bg); }
  .btn-primary { background: var(--btn-primary-bg); color: var(--btn-primary-fg); font-weight: 600; }
  .btn-primary:hover { background: var(--btn-primary-hover); }
</style>
</head>
<body>
  <div class="card">
    <div class="body">
      <div class="title">界面设置</div>
      <div class="imgrow">
        <span class="label">壁纸图片</span>
        <span class="imgname" id="imgname">${imageName}</span>
        <button class="smallbtn" id="pick">更换…</button>
        <button class="smallbtn" id="clearimg">清除</button>
      </div>
      <div class="row">
        <span class="label">侧栏壁纸</span>
        <div class="seg">
          <button class="segbtn ${sidebarImage === null ? 'on' : ''}" id="modeShared">与主界面共用</button>
          <button class="segbtn ${sidebarImage !== null ? 'on' : ''}" id="modeSep">单独设置</button>
        </div>
      </div>
      <div class="imgrow" id="sidebarRow" style="${sidebarImage === null ? 'display:none' : ''}">
        <span class="label">侧栏图片</span>
        <span class="imgname" id="sideimgname">${sidebarName}</span>
        <button class="smallbtn" id="sidepick">更换…</button>
        <button class="smallbtn" id="sideclear">清除</button>
      </div>
      <div class="desc" style="margin-top:6px;padding-left:104px">单独设置时侧栏用独立图片。</div>
      <div class="row">
        <span class="label">模糊程度</span>
        <input type="range" id="blur" min="0" max="64" step="1" value="${blur}">
        <span class="val" id="blurval">${blur}px</span>
      </div>
      <div class="desc" style="margin-top:6px;padding-left:104px">侧栏与主界面壁纸无缝衔接为一张图。</div>
      <div class="row">
        <span class="label">代码块透明度</span>
        <input type="range" id="alpha" min="8" max="100" step="1" value="${alphaPct}">
        <span class="val" id="alphaval">${alphaPct}%</span>
      </div>
      <div class="desc" style="margin-top:6px;padding-left:104px">数值越大越不透明（越实）。</div>
      <div class="row" style="margin-top:14px">
        <span class="label">透明区域</span>
        <div class="checks">
          <label class="check"><input type="checkbox" id="tNew" ${flags.newSession ? 'checked' : ''}><span>新对话</span></label>
          <label class="check"><input type="checkbox" id="tInput" ${flags.input ? 'checked' : ''}><span>输入框</span></label>
          <label class="check"><input type="checkbox" id="tSide" ${flags.sidebar ? 'checked' : ''}><span>左边栏</span></label>
          <label class="check"><input type="checkbox" id="tMain" ${flags.main ? 'checked' : ''}><span>主界面</span></label>
        </div>
      </div>
    </div>
    <div class="footer">
      <button class="btn btn-ghost" id="reset">恢复默认</button>
      <button class="btn btn-ghost" id="cancel">取消</button>
      <button class="btn btn-primary" id="ok">确定</button>
    </div>
  </div>
  <script>
    // 与关闭对话框同理：经 window 属性访问 contextBridge 注入的 API
    const api = window.dshWallpaperDialog
    const blurEl = document.getElementById('blur')
    const alphaEl = document.getElementById('alpha')
    const blurVal = document.getElementById('blurval')
    const alphaVal = document.getElementById('alphaval')
    const imgName = document.getElementById('imgname')
    const modeShared = document.getElementById('modeShared')
    const modeSep = document.getElementById('modeSep')
    const sidebarRow = document.getElementById('sidebarRow')
    const sideImgName = document.getElementById('sideimgname')
    const setMode = (separate) => {
      modeShared.classList.toggle('on', !separate)
      modeSep.classList.toggle('on', separate)
      sidebarRow.style.display = separate ? '' : 'none'
      api.setSidebarMode(separate ? 'separate' : 'shared')
    }
    modeShared.addEventListener('click', () => setMode(false))
    modeSep.addEventListener('click', () => setMode(true))
    const tFlags = () => ({
      newSession: document.getElementById('tNew').checked,
      input: document.getElementById('tInput').checked,
      sidebar: document.getElementById('tSide').checked,
      main: document.getElementById('tMain').checked,
    })
    const preview = () => {
      blurVal.textContent = blurEl.value + 'px'
      alphaVal.textContent = alphaEl.value + '%'
      api.preview({ blur: Number(blurEl.value), codeAlpha: Number(alphaEl.value) / 100, transparent: tFlags() })
    }
    blurEl.addEventListener('input', preview)
    alphaEl.addEventListener('input', preview)
    document.querySelectorAll('.checks input').forEach((el) => el.addEventListener('change', preview))
    document.getElementById('pick').addEventListener('click', () => api.pickImage())
    document.getElementById('clearimg').addEventListener('click', () => api.clearImage())
    document.getElementById('sidepick').addEventListener('click', () => api.pickSidebarImage())
    document.getElementById('sideclear').addEventListener('click', () => api.clearSidebarImage())
    api.onImageChosen((file) => {
      imgName.textContent = file === null ? '（无）' : file.split(/[\\\\/]/).pop()
    })
    api.onSidebarImageChosen((file) => {
      sideImgName.textContent = file === null ? '（无）' : file.split(/[\\\\/]/).pop()
      if (file !== null) setMode(true)
    })
    document.getElementById('reset').addEventListener('click', () => {
      blurEl.value = 18; alphaEl.value = 45; preview()
    })
    document.getElementById('cancel').addEventListener('click', () => api.commit({ ok: false }))
    document.getElementById('ok').addEventListener('click', () => api.commit({ ok: true, blur: Number(blurEl.value), codeAlpha: Number(alphaEl.value) / 100, transparent: tFlags() }))
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') api.commit({ ok: false })
      else if (event.key === 'Enter') api.commit({ ok: true, blur: Number(blurEl.value), codeAlpha: Number(alphaEl.value) / 100, transparent: tFlags() })
    })
    preview()
  </script>
</body>
</html>`
}

// 壁纸设置对话框状态
let blurDialog = null
let blurOriginal = 18
let codeOriginal = 0.45
let imageOriginal = null
let imageDraft = null // 对话框内更换后的主壁纸路径（null 表示无）
let sidebarOriginal = null // 对话框打开时的侧栏壁纸（null = 共用主图）
let sidebarDraft = null // 对话框内侧栏壁纸草稿（null = 共用主图）
let transparentOriginal = null // 对话框打开时的透明开关

/** 恢复对话框打开前的壁纸状态（取消时）。 */
function restoreWallpaperState() {
  const win = mainWindow
  if (win === null || win.isDestroyed()) return
  setWallpaperBlurVar(blurOriginal)
  setCodeAlphaVar(codeOriginal)
  setSidebarWallpaperLayer(win, sidebarOriginal === null ? null : wallpaperDataUrl(sidebarOriginal))
    .catch((error) => log('sidebar restore failed:', String(error)))
  if (transparentOriginal !== null) {
    win.webContents.executeJavaScript(`(() => {
      window.__dshWallpaperTransparent = ${JSON.stringify(transparentOriginal)}
      if (typeof window.__dshApplyWallpaperVars === 'function') window.__dshApplyWallpaperVars()
      return true
    })()`).catch(() => {})
  }
  if (imageOriginal === null) {
    win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('dsh-wallpaper-layer')
      if (el) el.style.display = 'none'
      if (typeof window.__dshWallpaperCleanup === 'function') window.__dshWallpaperCleanup()
      return true
    })()`).catch(() => {})
    if (wallpaperCssKey !== null) {
      win.webContents.removeInsertedCSS(wallpaperCssKey).catch(() => {})
      wallpaperCssKey = null
    }
  } else {
    applyWallpaper(win, imageOriginal)
  }
}

/** 文件菜单：打开壁纸设置对话框。 */
async function showWallpaperDialog() {
  if (blurDialog !== null && !blurDialog.isDestroyed()) {
    blurDialog.focus()
    return
  }
  // 跟随主窗口主题：亮/暗；主窗口卡顿时 1.5s 超时兜底为深色
  const win = mainWindow
  let dialogDark = true
  if (win !== null && !win.isDestroyed()) {
    try {
      dialogDark = await Promise.race([
        win.webContents.executeJavaScript(
          `document.body.hasAttribute('data-ds-dark-theme') || (getComputedStyle(document.documentElement).colorScheme || 'light') === 'dark'`,
        ),
        new Promise((resolve) => setTimeout(() => resolve(true), 1500)),
      ]) !== false
    } catch { /* 保持深色 */ }
  }
  blurOriginal = wallpaperBlur()
  codeOriginal = wallpaperCodeAlpha()
  imageOriginal = configuredWallpaper()
  imageDraft = imageOriginal
  sidebarOriginal = configuredSidebarWallpaper()
  sidebarDraft = sidebarOriginal
  transparentOriginal = transparentFlags()
  const dlg = new BrowserWindow({
    width: 420,
    height: 470,
    show: false,
    frame: false,
    // 同关闭对话框：不透明窗口（Windows 透明窗口有输入问题）
    backgroundColor: dialogDark ? '#151517' : '#f6f7f9',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    parent: mainWindow,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'wallpaper-dialog', 'preload.js'),
    },
  })
  blurDialog = dlg
  dlg.setMenu(null)
  dlg.once('ready-to-show', () => dlg.show())
  dlg.on('closed', () => {
    blurDialog = null
  })
  dlg.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildWallpaperDialogHtml(blurOriginal, codeOriginal, imageOriginal, sidebarOriginal, transparentOriginal, dialogDark))}`)
}

// 滑块/开关实时预览（模糊 + 代码块透明度 + 区域透明开关）
ipcMain.on('dsh:wallpaper-preview', (_event, payload) => {
  if (payload?.blur !== undefined) setWallpaperBlurVar(payload.blur)
  if (payload?.codeAlpha !== undefined) setCodeAlphaVar(payload.codeAlpha)
  if (payload?.transparent !== undefined) setTransparentFlags(payload.transparent)
})

/** 把区域透明开关写入页面并即时重应用（对话框预览用）。 */
function setTransparentFlags(flags) {
  const win = mainWindow
  if (win === null || win.isDestroyed()) return
  const value = {
    newSession: flags.newSession !== false,
    input: flags.input !== false,
    sidebar: flags.sidebar !== false,
    main: flags.main !== false,
  }
  win.webContents.executeJavaScript(`(() => {
    window.__dshWallpaperTransparent = ${JSON.stringify(value)}
    if (typeof window.__dshApplyWallpaperVars === 'function') window.__dshApplyWallpaperVars()
    return true
  })()`).catch(() => {})
}

// 对话框内更换图片：弹出文件选择，即时应用到主窗口
ipcMain.on('dsh:wallpaper-pick-image', async (_event) => {
  const win = mainWindow
  const dlg = blurDialog
  if (win === null || win.isDestroyed() || dlg === null || dlg.isDestroyed()) return
  const result = await dialog.showOpenDialog(win, {
    title: '选择壁纸图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return
  const file = result.filePaths[0]
  imageDraft = file
  try {
    await setWallpaperLayer(win, wallpaperDataUrl(file))
    log(`wallpaper preview: ${file}`)
  } catch (error) {
    log('wallpaper preview failed:', String(error))
  }
  dlg.webContents.send('dsh:wallpaper-image-chosen', file)
})

// 对话框内清除图片：即时移除壁纸变量（伪元素失去背景图即无壁纸）
ipcMain.on('dsh:wallpaper-clear-image', async () => {
  const win = mainWindow
  const dlg = blurDialog
  if (win === null || win.isDestroyed() || dlg === null || dlg.isDestroyed()) return
  imageDraft = null
  try {
    await win.webContents.executeJavaScript(`(() => {
      document.body.style.removeProperty('--dsh-wallpaper-url')
      return true
    })()`)
    log('wallpaper preview: cleared')
  } catch (error) {
    log('wallpaper clear preview failed:', String(error))
  }
  dlg.webContents.send('dsh:wallpaper-image-chosen', null)
})

// 对话框内选择侧栏独立壁纸：即时应用
ipcMain.on('dsh:wallpaper-pick-sidebar-image', async (_event) => {
  const win = mainWindow
  const dlg = blurDialog
  if (win === null || win.isDestroyed() || dlg === null || dlg.isDestroyed()) return
  const result = await dialog.showOpenDialog(win, {
    title: '选择侧栏壁纸图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return
  const file = result.filePaths[0]
  sidebarDraft = file
  try {
    await setSidebarWallpaperLayer(win, wallpaperDataUrl(file))
    log(`sidebar wallpaper preview: ${file}`)
  } catch (error) {
    log('sidebar wallpaper preview failed:', String(error))
  }
  dlg.webContents.send('dsh:wallpaper-sidebar-image-chosen', file)
})

// 对话框内清除侧栏独立壁纸：回到共用主图
ipcMain.on('dsh:wallpaper-clear-sidebar-image', async () => {
  const win = mainWindow
  const dlg = blurDialog
  if (win === null || win.isDestroyed() || dlg === null || dlg.isDestroyed()) return
  sidebarDraft = null
  try {
    await setSidebarWallpaperLayer(win, null)
    log('sidebar wallpaper preview: cleared')
  } catch (error) {
    log('sidebar wallpaper clear preview failed:', String(error))
  }
  dlg.webContents.send('dsh:wallpaper-sidebar-image-chosen', null)
})

// 侧栏壁纸模式切换：共用主图 / 单独设置
ipcMain.on('dsh:wallpaper-sidebar-mode', async (_event, mode) => {
  const win = mainWindow
  if (win === null || win.isDestroyed()) return
  if (mode === 'shared') {
    sidebarDraft = null
    await setSidebarWallpaperLayer(win, null)
      .catch((error) => log('sidebar mode shared failed:', String(error)))
  } else {
    sidebarDraft = sidebarOriginal
    if (sidebarOriginal !== null) {
      await setSidebarWallpaperLayer(win, wallpaperDataUrl(sidebarOriginal))
        .catch((error) => log('sidebar mode separate failed:', String(error)))
    }
  }
})

// 确定/取消：ok=true 保存全部设置（滑块当前值 + 图片草稿）；否则还原
ipcMain.on('dsh:wallpaper-commit', (_event, payload) => {
  if (payload?.ok) {
    const cfg = {}
    if (payload.blur !== undefined) cfg.wallpaperBlur = Math.max(0, Math.min(100, Number(payload.blur) || 0))
    if (payload.codeAlpha !== undefined) {
      cfg.wallpaperCodeAlpha = Math.max(0.08, Math.min(1, Number(payload.codeAlpha) || 0.45))
    }
    if (imageDraft === null) cfg.wallpaper = undefined
    else cfg.wallpaper = imageDraft
    if (sidebarDraft === null) cfg.sidebarWallpaper = undefined
    else cfg.sidebarWallpaper = sidebarDraft
    if (payload.transparent !== undefined) {
      cfg.transparentNewSession = payload.transparent.newSession !== false
      cfg.transparentInput = payload.transparent.input !== false
      cfg.transparentSidebar = payload.transparent.sidebar !== false
      cfg.transparentMain = payload.transparent.main !== false
    }
    saveConfig(cfg)
    const T = payload.transparent
    log(`wallpaper settings saved: blur=${cfg.wallpaperBlur ?? '?'}px codeAlpha=${cfg.wallpaperCodeAlpha ?? '?'} image=${imageDraft ?? '(none)'} sidebar=${sidebarDraft ?? '(shared)'} transparent=${T ? `${T.newSession}/${T.input}/${T.sidebar}/${T.main}` : '?'}`)
  } else {
    restoreWallpaperState()
  }
  const dlg = blurDialog
  if (dlg !== null && !dlg.isDestroyed()) dlg.close()
})

// ---------------------------------------------------------------- 窗口 ----

let mainWindow = null

function createWindow(url, wallpaper) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    // 一体化标题栏：无边框，标题栏由注入到 GUI 页面的自绘栏承担
    // （左侧 返回/前进/菜单，右侧 最小化/最大化/关闭）
    frame: false,
    backgroundColor: '#101318',
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'titlebar', 'preload.js'),
    },
  })

  win.once('ready-to-show', () => {
    win.show()
    // Windows 无边框窗口偶发以最小化状态出现（show:false + frame:false 怪癖）
    if (win.isMinimized()) win.restore()
  })

  // 点 ×（或 Alt+F4）不直接退出：先弹出 DSH 风格的关闭询问（隐藏到托盘 / 直接退出）
  win.on('close', (event) => {
    if (appQuitting || !trayEnabled) return
    event.preventDefault()
    if (closeDialog !== null && !closeDialog.isDestroyed()) {
      closeDialog.focus()
      return
    }
    askCloseAction().then((action) => {
      if (action === 'quit') {
        appQuitting = true
        app.quit()
      } else if (action === 'tray') {
        hideToTray()
      }
    })
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  win.on('maximize', () => win.webContents.send('dsh:tb-max-state', true))
  win.on('unmaximize', () => win.webContents.send('dsh:tb-max-state', false))

  // 一体化标题栏的返回/前进：历史栈由页面 document.title 驱动
  // （DSH 是 SPA，会话/项目切换不改 URL，但标题会变成 "会话名 — DeepSeek Harness"）
  tbNav = { stack: [], index: -1, suppress: 0 }
  win.webContents.on('did-navigate', (_event, _navUrl) => {
    // 页面级导航（含刷新）后清空历史，等页面轮询以当前视图重建
    tbNav.stack = []
    tbNav.index = -1
    tbSendNav(win)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    log(`renderer gone: reason=${details.reason} exitCode=${details.exitCode}`)
  })
  win.on('unresponsive', () => log('window unresponsive'))

  // 页面内新窗口一律交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://') || target.startsWith('https://')) shell.openExternal(target)
    return { action: 'deny' }
  })
  // 阻止导航到本地站点之外
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault()
      if (target.startsWith('http://') || target.startsWith('https://')) shell.openExternal(target)
    }
  })

  const smoke = process.argv.includes('--smoke-test')
  const smokeExit = (code) => {
    // app.exit 不触发退出事件，自己拉起的后端必须在此同步回收
    quitting = true
    if (!serverExternal) killServer(true)
    app.exit(code)
  }
  win.webContents.on('did-finish-load', () => {
    // 启动画面（file:// 壁纸页）不算 GUI 加载完成
    if (!win.webContents.getURL().startsWith(url)) return
    log(`page loaded: ${win.webContents.getURL()}`)
    // 页面重载后 insertCSS 的 key 失效，必须重置才能重新注入
    wallpaperCssKey = null
    // 每次加载都重新读最新配置：对话框换图/清除后刷新，不能回退到启动时的旧图
    const current = resolveWallpaper()
    if (current !== null) applyWallpaper(win, current)
    applySidebarWallpaper(win)
    injectTitlebar(win)
    tbSendNav(win)
    if (smoke) {
      const title = win.webContents.getTitle()
      console.log(`SMOKE_OK ${JSON.stringify({ title, url: win.webContents.getURL() })}`)
      smokeExit(0)
    }
  })
  win.webContents.on('did-fail-load', (_event, code, desc) => {
    log(`page load failed: ${code} ${desc}`)
    if (smoke) {
      console.log(`SMOKE_FAIL ${JSON.stringify({ code, desc })}`)
      smokeExit(1)
    }
  })

  win.loadURL(url)
  mainWindow = win
  return win
}

// ---------------------------------------------------------------- 标题栏 ----

let tbNav = null // { stack: string[], index: number, suppress: number }

/** 把标题栏 CSS/JS 注入 GUI 页面（每次页面加载后调用）。 */
function injectTitlebar(win) {
  try {
    const css = fs.readFileSync(path.join(__dirname, 'titlebar', 'inject.css'), 'utf8')
    const js = fs.readFileSync(path.join(__dirname, 'titlebar', 'inject.js'), 'utf8')
    win.webContents.insertCSS(css).catch(() => {})
    win.webContents.executeJavaScript(js).catch((error) => log('titlebar inject failed:', String(error)))
  } catch (error) {
    log('titlebar files missing:', String(error))
  }
}

/** 推送返回/前进按钮可用状态。 */
function tbSendNav(win) {
  if (win === null || win.isDestroyed() || tbNav === null) return
  win.webContents.send('dsh:tb-nav-state', {
    canBack: tbNav.index > 0,
    canForward: tbNav.index < tbNav.stack.length - 1,
  })
}

/**
 * 记录一次"视图"变化（由页面轮询"选中会话索引"上报触发）。
 * DSH 是 SPA，项目/会话切换不改 URL；后退历史以选中会话在会话列表
 * （[role=treeitem]）中的索引为条目，后退时按索引点击对应会话项。
 */
function tbPushTitle(index) {
  if (tbNav === null) return
  if (tbNav.suppress > 0) return
  const i = Number(index)
  if (tbNav.stack[tbNav.index] === i) return // 同视图去重（含后退/前进切回）
  tbNav.stack.splice(tbNav.index + 1, tbNav.stack.length - tbNav.index - 1, i)
  tbNav.index = tbNav.stack.length - 1
  tbSendNav(mainWindow)
}

/**
 * 后退/前进（delta = -1 / +1）：按目标条目的会话索引点击页面会话列表项
 * （[role=treeitem]），切换回之前看过的项目。
 */
async function titlebarGo(delta) {
  const win = mainWindow
  if (win === null || win.isDestroyed() || tbNav === null || tbNav.suppress > 0) return
  const can = delta < 0 ? tbNav.index > 0 : tbNav.index < tbNav.stack.length - 1
  if (!can) return
  const target = tbNav.stack[tbNav.index + delta]
  tbNav.index += delta
  tbSendNav(win)
  if (target < 0) {
    // 目标为"无会话"初始态：暂无精确恢复方式，回滚
    tbNav.index -= delta
    tbSendNav(win)
    return
  }
  tbNav.suppress++
  try {
    const clicked = await win.webContents.executeJavaScript(
      `(() => {
        const items = Array.from(document.querySelectorAll('[role=treeitem]'));
        const el = items[${target}];
        if (!el) return 'missing';
        const rect = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));
        return 'clicked';
      })()`
    )
    // 等待目标会话项被选中（aria-selected=true），期间上报被 suppress 忽略
    const deadline = Date.now() + 3000
    let ok = false
    while (Date.now() < deadline) {
      const sel = await win.webContents.executeJavaScript(
        `(() => { const items = Array.from(document.querySelectorAll('[role=treeitem]')); const el = items[${target}]; return el ? el.getAttribute('aria-selected') : 'gone'; })()`
      ).catch(() => '')
      if (sel === 'true') { ok = true; break }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (!ok) {
      tbNav.index -= delta
      log(`titlebar ${delta < 0 ? 'back' : 'forward'}: session ${target} not selected (click=${clicked})`)
    }
  } catch (error) {
    log('titlebar go failed:', String(error))
  }
  tbNav.suppress = Math.max(0, tbNav.suppress - 1)
  tbSendNav(win)
}

// 一体化标题栏 IPC：窗口控制 / 导航 / 菜单
ipcMain.on('dsh:tb-back', () => { titlebarGo(-1) })
ipcMain.on('dsh:tb-forward', () => { titlebarGo(1) })
ipcMain.on('dsh:tb-title', (_event, index) => tbPushTitle(index))
ipcMain.on('dsh:tb-minimize', () => {
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.minimize()
})
ipcMain.on('dsh:tb-maximize-toggle', () => {
  const win = mainWindow
  if (win === null || win.isDestroyed()) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})
ipcMain.on('dsh:tb-close', () => {
  // 走 close 事件：触发「隐藏到托盘 / 直接退出」询问
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.close()
})
// 标题栏「文件/视图/帮助」→ 下发菜单项，页面自绘下拉菜单（跟随外观）
ipcMain.on('dsh:tb-menu', (event, payload) => {
  const { name, x, y } = payload || {}
  const submenu = titlebarMenus === null ? null : titlebarMenus[name]
  if (submenu === undefined) return
  event.sender.send('dsh:tb-menu-data', {
    name,
    x: Math.round(x),
    y: Math.round(y),
    items: submenu.map((item) => item.type === 'separator'
      ? { type: 'separator' }
      : { id: item.id, label: item.label, enabled: item.enabled !== false, accelerator: item.accelerator || '' }),
  })
})
// 自绘菜单项点击 → 主进程执行对应动作
ipcMain.on('dsh:tb-menu-action', (_event, id) => {
  if (typeof id === 'string') runTitlebarAction(id)
})

// ---------------------------------------------------------------- 托盘 ----

let tray = null
let trayEnabled = true
let appQuitting = false
let firstHideToTray = true
let closeDialog = null
let resolveCloseAction = null

/** 隐藏主窗口到系统托盘（窗口不销毁，后端继续运行）。 */
function hideToTray() {
  const win = mainWindow
  if (win === null || win.isDestroyed()) return
  win.hide()
  if (firstHideToTray) {
    firstHideToTray = false
    if (process.platform === 'win32' && tray !== null) {
      tray.displayBalloon({
        icon: iconPath(),
        title: APP_NAME,
        content: '已隐藏到系统托盘，应用与后端服务继续在后台运行。点击托盘图标即可恢复窗口。',
      })
    }
  }
  log('window hidden to tray')
}

/** 从托盘恢复主窗口。 */
function showMainWindow() {
  const win = mainWindow
  if (win === null || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

/**
 * 在 asar 打包目录或安装目录 resources/ 中查找图标文件。
 * 打包版 build/ 目录随 asar 分发；若打包时漏掉（例如手工 asar pack 未带 build/），
 * 回退到磁盘上的 resources/ 目录（安装后始终存在），保证托盘与对话框 logo 不丢。
 * @param {string} name 图标文件名（如 icon.ico / icon.png）
 * @returns {string | undefined} 存在的图标路径，找不到返回 undefined
 */
function resolveIcon(name) {
  const candidates = [
    path.join(__dirname, 'build', name),
    path.join(process.resourcesPath ?? '', name),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate))
}

/** 创建系统托盘图标与右键菜单。 */
function createTray() {
  let image = nativeImage.createEmpty()
  const ico = resolveIcon('icon.ico')
  const png = resolveIcon('icon.png')
  if (ico) {
    image = nativeImage.createFromPath(ico)
  } else if (png) {
    image = nativeImage.createFromPath(png).resize({ width: 16, height: 16 })
  }
  tray = new Tray(image)
  tray.setToolTip(`${APP_NAME} — 单击显示主窗口`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { label: '隐藏主窗口', click: hideToTray },
    { type: 'separator' },
    { label: '界面设置…', click: () => { showMainWindow(); showWallpaperDialog() } },
    { type: 'separator' },
    { label: '在浏览器中打开', click: () => shell.openExternal(`http://${DEFAULT_HOST}:${resolvePort()}`) },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        appQuitting = true
        app.quit()
      },
    },
  ]))
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
  log('tray created')
}

/**
 * 关闭确认对话框页眉图标（base64 data URI）。打包版 build/ 目录随 asar 分发，
 * 开发版直接用仓库里的图标；均缺失时回退安装目录 resources/。
 */
function closeDialogIconDataUri() {
  const iconFile = resolveIcon('icon.png')
  if (!iconFile) return ''
  const image = nativeImage.createFromPath(iconFile).resize({ width: 32, height: 32 })
  return image.isEmpty() ? '' : `data:image/png;base64,${image.toPNG().toString('base64')}`
}

/**
 * 弹出关闭确认对话框（无边框、DSH 风格、模态于主窗口）。
 * 页面：close-dialog/index.html，preload 把按钮结果回传主进程。
 * @returns {Promise<'cancel'|'tray'|'quit'>}
 */
function askCloseAction() {
  return new Promise((resolve) => {
    resolveCloseAction = resolve
    const dlg = new BrowserWindow({
      width: 480,
      height: 250,
      show: false,
      frame: false,
      // 注意：不要用 transparent: true —— Windows 上透明窗口会收不到真实鼠标
      // 点击（按钮全部失效，只能任务管理器强杀），必须用不透明窗口。
      backgroundColor: '#151517',
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      parent: mainWindow,
      modal: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, 'close-dialog', 'preload.js'),
      },
    })
    closeDialog = dlg
    dlg.setMenu(null)
    dlg.once('ready-to-show', () => dlg.show())
    dlg.on('closed', () => {
      closeDialog = null
      const done = resolveCloseAction
      resolveCloseAction = null
      if (typeof done === 'function') done('cancel')
    })
    dlg.loadFile(path.join(__dirname, 'close-dialog', 'index.html'))
  })
}

// 对话框按钮 / 快捷键 → 主进程（action: cancel | tray | quit）
ipcMain.on('dsh:close-dialog-action', (_event, action) => {
  const valid = ['cancel', 'tray', 'quit'].includes(action) ? action : 'cancel'
  const done = resolveCloseAction
  resolveCloseAction = null
  if (typeof done === 'function') done(valid)
  const dlg = closeDialog
  if (dlg !== null && !dlg.isDestroyed()) dlg.close()
})

// 对话框请求页眉图标（base64 经 IPC 传递，避免 URL 编码把 '+' 解码成空格损坏图片）
ipcMain.handle('dsh:close-dialog-icon', () => closeDialogIconDataUri())

// ---------------------------------------------------------------- 菜单 ----

// 菜单子模板：应用菜单（保留快捷键，无边框窗口下不显示）与标题栏自绘下拉菜单共用。
// 每项带稳定 id：下拉菜单渲染时下发 id，点击后经 IPC 回主进程执行。
let titlebarMenus = null
let menuRuntime = null
let menuUrl = ''

function menuSubmenus(runtime, url) {
  return {
    file: [
      { id: 'open-external', label: '在浏览器中打开' },
      { type: 'separator' },
      { id: 'settings', label: '界面设置…' },
      { id: 'clear-wallpaper', label: '清除壁纸' },
      { type: 'separator' },
      { id: 'hide-tray', label: '隐藏到托盘', enabled: trayEnabled },
      { type: 'separator' },
      { id: 'quit', label: '退出', accelerator: 'Alt+F4' },
    ],
    view: [
      { id: 'reload', label: '重新加载', accelerator: 'Ctrl+R' },
      { id: 'force-reload', label: '强制重新加载', accelerator: 'Ctrl+Shift+R' },
      { type: 'separator' },
      { id: 'reset-zoom', label: '实际大小', accelerator: 'Ctrl+0' },
      { id: 'zoom-in', label: '放大', accelerator: 'Ctrl++' },
      { id: 'zoom-out', label: '缩小', accelerator: 'Ctrl+-' },
      { type: 'separator' },
      { id: 'fullscreen', label: '全屏', accelerator: 'F11' },
      { id: 'devtools', label: '开发者工具', accelerator: 'Ctrl+Shift+I' },
    ],
    help: [
      { id: 'open-dsh-dir', label: '打开 DSH 目录' },
      { id: 'open-logs', label: '打开日志目录' },
      { type: 'separator' },
      { id: 'about', label: '关于' },
    ],
  }
}

/** 执行标题栏菜单动作（自绘下拉菜单点击 / 应用菜单兜底共用）。 */
function runTitlebarAction(id) {
  const w = mainWindow
  switch (id) {
    case 'open-external': shell.openExternal(menuUrl); break
    case 'settings': showWallpaperDialog(); break
    case 'clear-wallpaper': clearWallpaper(); break
    case 'hide-tray': hideToTray(); break
    case 'quit': appQuitting = true; app.quit(); break
    case 'reload': if (w !== null && !w.isDestroyed()) w.webContents.reload(); break
    case 'force-reload': if (w !== null && !w.isDestroyed()) w.webContents.reloadIgnoringCache(); break
    case 'reset-zoom': if (w !== null && !w.isDestroyed()) w.webContents.setZoomLevel(0); break
    case 'zoom-in': if (w !== null && !w.isDestroyed()) w.webContents.setZoomLevel(w.webContents.getZoomLevel() + 0.5); break
    case 'zoom-out': if (w !== null && !w.isDestroyed()) w.webContents.setZoomLevel(w.webContents.getZoomLevel() - 0.5); break
    case 'fullscreen': if (w !== null && !w.isDestroyed()) w.setFullScreen(!w.isFullScreen()); break
    case 'devtools': if (w !== null && !w.isDestroyed()) w.webContents.toggleDevTools(); break
    case 'open-dsh-dir': shell.openPath(menuRuntime.root); break
    case 'open-logs': shell.openPath(path.join(app.getPath('userData'), 'logs')); break
    case 'about':
      dialog.showMessageBox({
        type: 'info',
        title: APP_NAME,
        message: APP_NAME,
        detail: `版本 ${app.getVersion()}\n`
          + `运行时: ${menuRuntime.root}（${menuRuntime.bundled ? '内置' : '外部'}）\n`
          + `服务地址: ${menuUrl}\n`
          + `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
      })
      break
  }
}

// 原生角色映射：应用菜单（快捷键）复用同一份模板
const NATIVE_ROLE_BY_ID = {
  reload: 'reload',
  'force-reload': 'forceReload',
  'reset-zoom': 'resetZoom',
  'zoom-in': 'zoomIn',
  'zoom-out': 'zoomOut',
  fullscreen: 'togglefullscreen',
  devtools: 'toggleDevTools',
  quit: 'quit',
}

function toNativeMenuItem(item) {
  if (item.type === 'separator') return { type: 'separator' }
  const role = NATIVE_ROLE_BY_ID[item.id]
  const native = { label: item.label }
  if (role !== undefined) native.role = role
  else native.click = () => runTitlebarAction(item.id)
  if (item.enabled === false) native.enabled = false
  return native
}

function buildMenu(runtime, url) {
  menuRuntime = runtime
  menuUrl = url
  titlebarMenus = menuSubmenus(runtime, url)
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: '文件', submenu: titlebarMenus.file.map(toNativeMenuItem) },
    { label: '视图', submenu: titlebarMenus.view.map(toNativeMenuItem) },
    { label: '帮助', submenu: titlebarMenus.help.map(toNativeMenuItem) },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------- 图标 ----

function iconPath() {
  for (const name of ['icon.ico', 'icon.png']) {
    const candidate = resolveIcon(name)
    if (candidate) return candidate
  }
  return undefined
}

// ---------------------------------------------------------------- 启动 ----

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 已在托盘运行时再次启动：恢复主窗口
    showMainWindow()
  })

  app.whenReady().then(async () => {
    // Windows 通知（托盘气泡）需要 AppUserModelID
    app.setAppUserModelId('ai.deepseek.dsh-desktop')
    trayEnabled = !process.argv.includes('--no-tray') && !process.argv.includes('--smoke-test')

    const runtime = resolveRuntime()
    if (runtime === null) {
      dialog.showErrorBox(APP_NAME,
        `找不到 DSH 后端运行时。\n\n请用 --dsh-root=<路径> 或环境变量 DSH_ROOT 指定仓库，`
        + `或把路径写入配置文件：${configPath()}`)
      app.quit()
      return
    }
    log(`runtime = ${runtime.root} (${runtime.bundled ? 'bundled' : 'external'})`)

    const webDist = runtime.bundled
      ? path.join(runtime.root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html')
      : path.join(runtime.root, 'apps', 'web', 'dist', 'index.html')
    if (!fs.existsSync(webDist)) {
      dialog.showErrorBox(APP_NAME,
        `Web 界面尚未构建：缺少 ${webDist}\n\n`
        + (runtime.bundled
          ? '内置运行时损坏，请重新安装本应用。'
          : '请在 DSH 仓库执行：pnpm run build:web'))
      app.quit()
      return
    }

    const port = resolvePort()
    const url = `http://${DEFAULT_HOST}:${port}`
    log(`target url = ${url}`)

    const noServer = process.argv.includes('--no-server')
    if (!noServer) {
      const alive = await probe(url)
      if (alive) {
        log('GUI already running on port, attaching (server not owned by this app)')
        serverExternal = true
      } else {
        serverChild = startServer(runtime, port)
        const up = await waitForUrl(url, 90_000)
        if (!up) {
          dialog.showErrorBox(APP_NAME,
            `后端在 ${url} 上 90 秒内未就绪。\n请查看日志：${logFile('dsh-web.err.log')}`)
          killServer()
          app.quit()
          return
        }
        log('backend is ready')
      }
    } else {
      serverExternal = true
      const alive = await probe(url)
      if (!alive) {
        dialog.showErrorBox(APP_NAME, `--no-server 模式下未发现 ${url} 上的 GUI。`)
        app.quit()
        return
      }
    }

    // 只记住外部仓库路径，不记端口；内置模式与冒烟测试不落盘
    if (!runtime.bundled && !process.argv.includes('--smoke-test')) saveConfig({ dshRoot: runtime.root })
    const wallpaper = resolveWallpaper()
    log(`wallpaper = ${wallpaper === null ? '(none)' : wallpaper}`)
    buildMenu(runtime, url)
    createWindow(url, wallpaper)
    if (trayEnabled) createTray()
  })

  app.on('window-all-closed', () => {
    // 托盘模式下窗口只隐藏不关闭；走到这里说明是真正退出（或 --no-tray）
    quitting = true
    if (!serverExternal) killServer()
    app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    appQuitting = true
  })

  app.on('will-quit', () => {
    if (!serverExternal) killServer()
    if (tray !== null) {
      tray.destroy()
      tray = null
    }
  })
}
