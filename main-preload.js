'use strict'

/**
 * 主窗口 preload：
 *  1. 一体化标题栏能力（最小化/最大化/关闭、返回/前进、菜单）——原 titlebar/preload.js；
 *  2. 壁纸式启动过渡：页面脚本执行前注入壁纸背景 CSS（dsh-wallpaper:// 媒体），
 *     并通过 contextBridge 暴露启动画面模式——页面在 跟随主题/自定义 模式下
 *     加载期间不渲染 HARNESS 加载卡片，壁纸从启动到主界面全程连续显示。
 *
 * 壁纸背景只对 http(s) 页面注入：splash.html 是 file://，对话框是 data:，自动跳过。
 */

const { contextBridge, ipcRenderer } = require('electron')

// ---------------------------------------------------------------- 标题栏 ----

// 与关闭对话框同理：页面侧不要用 `const { dshTitlebar } = window` 解构，
// 必须经 window 属性访问（沙箱 contextBridge 注入的是非可配置 const 绑定）。
contextBridge.exposeInMainWorld('dshTitlebar', {
  back: () => ipcRenderer.send('dsh:tb-back'),
  forward: () => ipcRenderer.send('dsh:tb-forward'),
  menu: (name, x, y) => ipcRenderer.send('dsh:tb-menu', { name, x, y }),
  menuAction: (id) => ipcRenderer.send('dsh:tb-menu-action', id),
  minimize: () => ipcRenderer.send('dsh:tb-minimize'),
  maximizeToggle: () => ipcRenderer.send('dsh:tb-maximize-toggle'),
  close: () => ipcRenderer.send('dsh:tb-close'),
  // 页面轮询"选中会话索引"上报（会话/项目切换时变化，用于后退历史）
  notifyTitle: (index) => ipcRenderer.send('dsh:tb-title', Number(index)),
  onNavState: (cb) => ipcRenderer.on('dsh:tb-nav-state', (_event, state) => cb(state)),
  onMaxState: (cb) => ipcRenderer.on('dsh:tb-max-state', (_event, maximized) => cb(maximized)),
  onMenuData: (cb) => ipcRenderer.on('dsh:tb-menu-data', (_event, payload) => cb(payload)),
})

// ------------------------------------------------------------ 界面设置桥 ----

// web 设置面板「界面设置」（dsh-interface-settings 插件）经此通道读写
// Electron 配置并由主进程应用（含视频壁纸/视频声音等桌面独有能力）。
contextBridge.exposeInMainWorld('dshInterfaceSettings', {
  get: () => ipcRenderer.sendSync('dsh:interface-settings-get'),
  preview: (settings) => ipcRenderer.send('dsh:interface-settings-preview', settings),
  commit: (settings) => ipcRenderer.send('dsh:interface-settings-commit', settings),
  pick: (kind) => ipcRenderer.invoke('dsh:interface-settings-pick', kind),
  clear: (kind) => ipcRenderer.send('dsh:interface-settings-clear', kind),
  // 启动画面视频时长上限（秒）；无视频素材返回 null
  splashDurationMax: () => ipcRenderer.invoke('dsh:interface-settings-splash-duration'),
})

// ------------------------------------------------------------ 壁纸式启动过渡 --

let payload = {}
try {
  payload = ipcRenderer.sendSync('dsh:splash-cover-query') || {}
} catch { /* 主进程未就绪时忽略 */ }
const media = payload.media || ''
const bg = typeof payload.bg === 'string' && payload.bg !== '' ? payload.bg : '#101318'
const mode = typeof payload.mode === 'string' && payload.mode !== '' ? payload.mode : 'default'
const blur = Number.isFinite(Number(payload.blur)) ? Number(payload.blur) : 18
// 启动画面最小展示秒数：主界面就绪后仍至少展示这么久（0 = 不强制）
const minMs = Math.max(0, (Number.isFinite(Number(payload.duration)) ? Number(payload.duration) : 0) * 1000)
// 结束淡出毫秒数（0 = 直接切换，默认 0.5s）
const fadeMs = Math.max(0, (Number.isFinite(Number(payload.fade)) ? Number(payload.fade) : 0.5) * 1000)

const report = (msg) => { try { ipcRenderer.send('dsh:splash-cover-log', msg) } catch { /* 忽略 */ } }

// 暴露启动画面模式给页面（AppRoot 据此决定加载期是否渲染 HARNESS 卡片）
contextBridge.exposeInMainWorld('dshSplashMode', mode)

// 无媒体（默认模式）或非 http(s) 页面：不注入壁纸背景
if (media === '') return
if (typeof location !== 'undefined' && location.protocol !== 'http:' && location.protocol !== 'https:') return

const tryInject = () => {
  if (!document || !document.documentElement) {
    setTimeout(tryInject, 5)
    return
  }
  // 启动层盖在最顶层（z-index 最大）：主界面在下面加载但不可见，
  // 展示满 minMs（或主界面就绪且 minMs=0）后移除，主界面才出现。
  const isVideo = payload.isVideo === true || /\.(mp4|m4v|webm|mov|ogv)(\?|#|$)/i.test(media)
  let bootEl = null
  if (isVideo) {
    const v = document.createElement('video')
    v.id = 'dsh-wallpaper-boot'
    v.src = media
    v.autoplay = true
    v.loop = true
    v.muted = true
    v.playsInline = true
    v.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:2147483647'
    document.documentElement.appendChild(v)
    bootEl = v
  } else {
    // 图片：全屏 div，背景先主色（加载期无黑），图片就绪后覆盖
    const d = document.createElement('div')
    d.id = 'dsh-wallpaper-boot'
    d.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:${bg} center/cover no-repeat;background-image:url('${media}');filter:blur(${blur}px)`
    document.documentElement.appendChild(d)
    bootEl = d
  }
  report('WALLPAPER_BOOT_INJECTED')
  // 点击任意位置跳过剩余展示（主界面已加载好时立即进入）
  let skip = false
  bootEl.addEventListener('click', () => { skip = true })
  // 主界面渲染完成（输入框出现）且至少展示 minMs（或点击跳过）后淡出移除启动层；
  // 20s 超时兜底。
  const start = Date.now()
  let tries = 0
  let fading = false
  const iv = setInterval(() => {
    tries++
    const ready = document.querySelector('[class*="composerSeat"]') || document.querySelector('textarea') || document.querySelector('[contenteditable="true"]')
    const elapsed = Date.now() - start
    if (!fading && ((ready && (elapsed >= minMs || skip)) || tries > 400)) {
      clearInterval(iv)
      fading = true
      const el = document.getElementById('dsh-wallpaper-boot')
      if (el !== null) {
        // 淡出后再移除，让主界面平滑浮现
        el.style.transition = `opacity ${fadeMs}ms ease`
        el.style.opacity = '0'
        setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el) }, fadeMs)
      }
      report('REMOVED')
    }
  }, 50)
}
tryInject()
