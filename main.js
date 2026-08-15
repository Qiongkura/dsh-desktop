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
    // 主动终止（退出/冒烟测试）不视为意外退出；只有自己拉起的后端崩溃才弹窗
    if (!quitting && !serverExternal && !intentionalKill) {
      dialog.showErrorBox(APP_NAME,
        `DSH 后端进程意外退出（code=${code}）。\n日志：${logFile('dsh-web.err.log')}`)
      app.quit()
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
      background-image: var(--dsh-wallpaper-url) !important;
      background-position: center !important;
      background-size: cover !important;
      background-repeat: no-repeat !important;
    }
    /* 全窗：标准模糊 */
    body::before {
      left: 0 !important;
      right: 0 !important;
      filter: blur(var(--dsh-wallpaper-blur, 18px)) !important;
    }
    /* 左侧栏区域：更糊 1.6 倍（盖在 ::before 之上） */
    body::after {
      left: 0 !important;
      width: var(--dsh-sidebar-w, 280px) !important;
      filter: blur(calc(var(--dsh-wallpaper-blur, 18px) * 1.6)) !important;
    }
    #root [data-slot='root'] > div,
    #root [data-slot='root'] > div > div { background: transparent !important; }
    #root [data-slot='root'] > div > div > [data-slot] > div {
      background: var(--dsh-wallpaper-panel, rgba(255,255,255,0.55)) !important;
    }
    /* 输入框上方的渐变白带（composerSeat 的 transparent→bg-base 渐变）：
       改为主面板同色，消除半透明面板下的白色渐变带 */
    #root [class*='composerSeat'] {
      background: var(--dsh-wallpaper-panel, rgba(255,255,255,0.55)) !important;
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

/** 页面加载后应用壁纸：只做一次性 CSS 变量设置 + 写入壁纸 data URL。
 *  无 MutationObserver、无监听器、无探针 —— 全部是一次性赋值；
 *  代码块透明度/侧栏填充由 __dshApplyWallpaperVars() 按需手动重应用（对话框滑杆调用）。 */
function applyWallpaper(win, wallpaper) {
  injectWallpaperCss(win)
  const dataUrl = wallpaperDataUrl(wallpaper)
  win.webContents.executeJavaScript(`(() => {
    const scheme = getComputedStyle(document.documentElement).colorScheme || 'light'
    const dark = scheme === 'dark'
    document.documentElement.style.setProperty('--dsh-wallpaper-panel',
      dark ? 'rgba(12,15,22,0.58)' : 'rgba(255,255,255,0.55)')
    document.documentElement.style.setProperty('--dsh-wallpaper-blur', '${wallpaperBlur()}px')
    document.documentElement.style.setProperty('--dsh-wallpaper-code-alpha', '${wallpaperCodeAlpha()}')
    const applyVars = () => {
      const isDark = document.body.hasAttribute('data-ds-dark-theme')
        || (getComputedStyle(document.documentElement).colorScheme || 'light') === 'dark'
      const a = parseFloat(document.documentElement.style.getPropertyValue('--dsh-wallpaper-code-alpha'))
      const alpha = Number.isFinite(a) ? Math.max(0.08, Math.min(1, a)) : 0.45
      document.body.style.setProperty('--dsw-alias-markdown-code-block',
        isDark ? 'rgba(12,15,22,' + alpha + ')' : 'rgba(255,255,255,' + alpha + ')')
      document.body.style.setProperty('--dsw-alias-markdown-code-block-banner',
        isDark ? 'rgba(20,24,34,' + alpha + ')' : 'rgba(250,251,252,' + alpha + ')')
      // 行内代码灰底（聊天里反引号文字的浅灰背景）也跟随滑杆透明度
      document.body.style.setProperty('--dsw-alias-markdown-inline-code',
        isDark ? 'rgba(35,38,43,' + alpha + ')' : 'rgba(239,240,243,' + alpha + ')')
      // 侧栏滚动渐隐终点色：透明，消除设置键上方的白色渐变带
      document.body.style.setProperty('--dsw-specific-sidebar-fill', 'transparent')
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
      document.documentElement.style.removeProperty('--dsh-wallpaper-panel')
      document.documentElement.style.removeProperty('--dsh-wallpaper-blur')
      document.documentElement.style.removeProperty('--dsh-wallpaper-code-alpha')
    }
    return JSON.stringify({ scheme, blur: ${wallpaperBlur()}, codeAlpha: ${wallpaperCodeAlpha()} })
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

/** 构建壁纸设置对话框的 HTML（DSH 暗色风格，与关闭对话框一致）。
 *  @param blur 当前模糊值；@param codeAlpha 当前代码块透明度；@param image 当前壁纸路径或 null */
function buildWallpaperDialogHtml(blur, codeAlpha, image) {
  const imageName = image === null ? '（无）' : path.basename(image)
  const alphaPct = Math.round(codeAlpha * 100)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>壁纸设置</title>
<style>
  :root {
    --bg-base: #151517; --border-l2: rgba(255,255,255,0.12);
    --hover-bg: rgba(255,255,255,0.08); --label-primary: #f9fafb;
    --label-secondary: #81858c; --label-tertiary: #6b6f76; --accent: #4d6bfe;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; user-select: none; }
  html, body { height: 100%; }
  body {
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
  .btn-primary { background: #f9fafb; color: #0f1115; font-weight: 600; }
  .btn-primary:hover { background: #ebecf2; }
</style>
</head>
<body>
  <div class="card">
    <div class="body">
      <div class="title">壁纸设置</div>
      <div class="imgrow">
        <span class="label">壁纸图片</span>
        <span class="imgname" id="imgname">${imageName}</span>
        <button class="smallbtn" id="pick">更换…</button>
        <button class="smallbtn" id="clearimg">清除</button>
      </div>
      <div class="row">
        <span class="label">模糊程度</span>
        <input type="range" id="blur" min="0" max="64" step="1" value="${blur}">
        <span class="val" id="blurval">${blur}px</span>
      </div>
      <div class="desc" style="margin-top:6px;padding-left:104px">左侧栏固定比中间更模糊 1.6 倍。</div>
      <div class="row">
        <span class="label">代码块透明度</span>
        <input type="range" id="alpha" min="8" max="100" step="1" value="${alphaPct}">
        <span class="val" id="alphaval">${alphaPct}%</span>
      </div>
      <div class="desc" style="margin-top:6px;padding-left:104px">数值越大越不透明（越实）。</div>
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
    const preview = () => {
      blurVal.textContent = blurEl.value + 'px'
      alphaVal.textContent = alphaEl.value + '%'
      api.preview({ blur: Number(blurEl.value), codeAlpha: Number(alphaEl.value) / 100 })
    }
    blurEl.addEventListener('input', preview)
    alphaEl.addEventListener('input', preview)
    document.getElementById('pick').addEventListener('click', () => api.pickImage())
    document.getElementById('clearimg').addEventListener('click', () => api.clearImage())
    api.onImageChosen((file) => {
      imgName.textContent = file === null ? '（无）' : file.split(/[\\\\/]/).pop()
    })
    document.getElementById('reset').addEventListener('click', () => {
      blurEl.value = 18; alphaEl.value = 45; preview()
    })
    document.getElementById('cancel').addEventListener('click', () => api.commit({ ok: false }))
    document.getElementById('ok').addEventListener('click', () => api.commit({ ok: true, blur: Number(blurEl.value), codeAlpha: Number(alphaEl.value) / 100 }))
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') api.commit({ ok: false })
      else if (event.key === 'Enter') api.commit({ ok: true, blur: Number(blurEl.value), codeAlpha: Number(alphaEl.value) / 100 })
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
let imageDraft = null // 对话框内更换后的新壁纸路径（null 表示无）

/** 恢复对话框打开前的壁纸状态（取消时）。 */
function restoreWallpaperState() {
  const win = mainWindow
  if (win === null || win.isDestroyed()) return
  setWallpaperBlurVar(blurOriginal)
  setCodeAlphaVar(codeOriginal)
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
function showWallpaperDialog() {
  if (blurDialog !== null && !blurDialog.isDestroyed()) {
    blurDialog.focus()
    return
  }
  blurOriginal = wallpaperBlur()
  codeOriginal = wallpaperCodeAlpha()
  imageOriginal = configuredWallpaper()
  imageDraft = imageOriginal
  const dlg = new BrowserWindow({
    width: 420,
    height: 330,
    show: false,
    frame: false,
    // 同关闭对话框：不透明窗口（Windows 透明窗口有输入问题）
    backgroundColor: '#151517',
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
  dlg.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildWallpaperDialogHtml(blurOriginal, codeOriginal, imageOriginal))}`)
}

// 滑块实时预览（模糊 + 代码块透明度）
ipcMain.on('dsh:wallpaper-preview', (_event, payload) => {
  if (payload?.blur !== undefined) setWallpaperBlurVar(payload.blur)
  if (payload?.codeAlpha !== undefined) setCodeAlphaVar(payload.codeAlpha)
})

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

// 对话框内清除图片：即时隐藏
ipcMain.on('dsh:wallpaper-clear-image', async () => {
  const win = mainWindow
  const dlg = blurDialog
  if (win === null || win.isDestroyed() || dlg === null || dlg.isDestroyed()) return
  imageDraft = null
  try {
    await win.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('dsh-wallpaper-layer')
      if (el) el.style.display = 'none'
      return !!el
    })()`)
    log('wallpaper preview: cleared')
  } catch (error) {
    log('wallpaper clear preview failed:', String(error))
  }
  dlg.webContents.send('dsh:wallpaper-image-chosen', null)
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
    saveConfig(cfg)
    log(`wallpaper settings saved: blur=${cfg.wallpaperBlur ?? '?'}px codeAlpha=${cfg.wallpaperCodeAlpha ?? '?'} image=${imageDraft ?? '(none)'}`)
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
    backgroundColor: '#101318',
    icon: iconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())

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
    if (wallpaper !== null) applyWallpaper(win, wallpaper)
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

/** 创建系统托盘图标与右键菜单。 */
function createTray() {
  let image = nativeImage.createEmpty()
  const ico = path.join(__dirname, 'build', 'icon.ico')
  const png = path.join(__dirname, 'build', 'icon.png')
  if (fs.existsSync(ico)) {
    image = nativeImage.createFromPath(ico)
  } else if (fs.existsSync(png)) {
    image = nativeImage.createFromPath(png).resize({ width: 16, height: 16 })
  }
  tray = new Tray(image)
  tray.setToolTip(`${APP_NAME} — 单击显示主窗口`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { label: '隐藏主窗口', click: hideToTray },
    { type: 'separator' },
    { label: '壁纸设置…', click: () => { showMainWindow(); showWallpaperDialog() } },
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
 * 开发版直接用仓库里的图标。
 */
function closeDialogIconDataUri() {
  const iconFile = path.join(__dirname, 'build', 'icon.png')
  if (!fs.existsSync(iconFile)) return ''
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

function buildMenu(runtime, url) {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '在浏览器中打开', click: () => shell.openExternal(url) },
        { type: 'separator' },
        { label: '壁纸设置…', click: () => { showWallpaperDialog() } },
        { label: '清除壁纸', click: () => { clearWallpaper() } },
        { type: 'separator' },
        { label: '隐藏到托盘', enabled: trayEnabled, click: () => hideToTray() },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开 DSH 目录', click: () => shell.openPath(runtime.root) },
        { label: '打开日志目录', click: () => shell.openPath(path.join(app.getPath('userData'), 'logs')) },
        { type: 'separator' },
        {
          label: '关于',
          click: () => dialog.showMessageBox({
            type: 'info',
            title: APP_NAME,
            message: APP_NAME,
            detail: `版本 ${app.getVersion()}\n`
              + `运行时: ${runtime.root}（${runtime.bundled ? '内置' : '外部'}）\n`
              + `服务地址: ${url}\n`
              + `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
          }),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------- 图标 ----

function iconPath() {
  for (const name of ['icon.ico', 'icon.png']) {
    const candidate = path.join(__dirname, 'build', name)
    if (fs.existsSync(candidate)) return candidate
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
