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

// ------------------------------------------------------------ 壁纸式启动过渡 --

let payload = {}
try {
  payload = ipcRenderer.sendSync('dsh:splash-cover-query') || {}
} catch { /* 主进程未就绪时忽略 */ }
const media = payload.media || ''
const bg = typeof payload.bg === 'string' && payload.bg !== '' ? payload.bg : '#101318'
const mode = typeof payload.mode === 'string' && payload.mode !== '' ? payload.mode : 'default'
const blur = Number.isFinite(Number(payload.blur)) ? Number(payload.blur) : 18

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
  const isVideo = payload.isVideo === true || /\.(mp4|m4v|webm|mov|ogv)(\?|#|$)/i.test(media)
  if (isVideo) {
    // 视频：注入 <video> 壁纸层（CSS 背景不能渲染视频）。
    // 不加 !important，主界面加载后由主进程机制接管（本元素会被移除）。
    const v = document.createElement('video')
    v.id = 'dsh-wallpaper-boot'
    v.src = media
    v.autoplay = true
    v.loop = true
    v.muted = true
    v.playsInline = true
    v.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1;pointer-events:none'
    document.documentElement.appendChild(v)
    report('WALLPAPER_BOOT_INJECTED')
    return
  }
  // 图片：注入壁纸背景 CSS（无 !important，主界面机制可覆盖接管）
  const style = document.createElement('style')
  style.id = 'dsh-wallpaper-boot'
  style.textContent = `
    html { background: ${bg}; }
    body { background: transparent; }
    body::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: -1;
      pointer-events: none;
      background: url('${media}') center/cover no-repeat;
      filter: blur(${blur}px);
    }
  `
  document.documentElement.appendChild(style)
  report('WALLPAPER_BOOT_INJECTED')
}
tryInject()
