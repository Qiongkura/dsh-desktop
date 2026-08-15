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
 *  3. 用原生 BrowserWindow 加载 GUI，管理进程生命周期。
 *
 * 命令行参数：
 *  --dsh-root=<path>   指定 DSH 仓库根目录（外部模式）
 *  --port=<n>          指定后端端口（默认 3080）
 *  --no-server         只接管已运行的服务，绝不自己启动后端
 *  --smoke-test        加载完成后打印 SMOKE_OK/SMOKE_FAIL 并退出（自动化验证用）
 */

const { app, BrowserWindow, dialog, Menu, shell } = require('electron')
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

// ---------------------------------------------------------------- 窗口 ----

function createWindow(url) {
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
    log(`page loaded: ${win.webContents.getURL()}`)
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
  return win
}

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
    const win = BrowserWindow.getAllWindows()[0]
    if (win !== undefined) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
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
    buildMenu(runtime, url)
    createWindow(url)
  })

  app.on('window-all-closed', () => {
    quitting = true
    if (!serverExternal) killServer()
    app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('will-quit', () => {
    if (!serverExternal) killServer()
  })
}
