'use strict'

/**
 * 主窗口 preload：
 *  1. 一体化标题栏能力（最小化/最大化/关闭、返回/前进、菜单）——原 titlebar/preload.js；
 *  2. 启动画面无缝过渡：在页面脚本执行之前（documentElement 一出现）注入全屏
 *     覆盖层（启动画面媒体），主界面渲染完成（输入框出现）后淡出移除——
 *     GUI 加载期间的 DSH 加载界面（HARNESS / Loading plugins...）不会露出来。
 *
 * 覆盖层只对 http(s) 页面生效：splash.html 是 file://，自动跳过。
 * 媒体 URL 经 sendSync 从主进程取（dsh-wallpaper:// 纯字符串，无文件 IO）。
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

// ------------------------------------------------------------ 启动画面覆盖层 --

let payload = {}
try {
  payload = ipcRenderer.sendSync('dsh:splash-cover-query') || {}
} catch { /* 主进程未就绪时忽略 */ }
const media = payload.media || ''
const bg = typeof payload.bg === 'string' && payload.bg !== '' ? payload.bg : '#101318'
if (media === '') return
if (typeof location !== 'undefined' && location.protocol !== 'http:' && location.protocol !== 'https:') return

const report = (msg) => { try { ipcRenderer.send('dsh:splash-cover-log', msg) } catch { /* 忽略 */ } }
report('PRELOAD_RAN')

const isVideo = payload.isVideo === true || /\.(mp4|m4v|webm|mov|ogv)(\?|#|$)/i.test(media)

const tryInject = () => {
  if (!document || !document.documentElement) {
    setTimeout(tryInject, 5)
    return
  }
  const d = document.createElement('div')
  d.id = 'dsh-splash-cover'
  d.style.cssText = `position:fixed;inset:0;z-index:2147483647;background:${bg};overflow:hidden`
  d.innerHTML = isVideo
    ? `<video autoplay loop muted playsinline src="${media}" style="width:100%;height:100%;object-fit:cover"></video>`
    : `<img src="${media}" style="width:100%;height:100%;object-fit:cover">`
  document.documentElement.appendChild(d)
  report('INJECTED')
  const m = d.querySelector('img, video')
  if (m) {
    if (m instanceof HTMLVideoElement) {
      m.addEventListener('loadedmetadata', () => report('VIDEO_METADATA'))
      m.addEventListener('canplay', () => report('VIDEO_CANPLAY'))
      m.addEventListener('playing', () => report('VIDEO_PLAYING'))
      m.addEventListener('error', () => report('VIDEO_ERROR'))
    } else {
      m.addEventListener('load', () => report('MEDIA_LOADED'))
      m.addEventListener('error', () => report('MEDIA_ERROR'))
    }
  }
  let tries = 0
  const iv = setInterval(() => {
    tries++
    const ready = document.querySelector('[class*="composerSeat"]') || document.querySelector('textarea') || document.querySelector('[contenteditable="true"]')
    if (ready || tries > 400) {
      clearInterval(iv)
      d.style.transition = 'opacity .35s ease'
      d.style.opacity = '0'
      setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); report('REMOVED') }, 400)
    }
  }, 50)
}
tryInject()
