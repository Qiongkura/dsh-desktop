'use strict'

/**
 * 一体化标题栏的 preload：把窗口控制（最小化/最大化/关闭）、返回/前进、
 * 菜单弹出等能力暴露给注入到 GUI 页面的标题栏脚本。
 * 与关闭对话框同理：页面侧不要用 `const { dshTitlebar } = window` 解构，
 * 必须经 window 属性访问（沙箱 contextBridge 注入的是非可配置 const 绑定）。
 */

const { contextBridge, ipcRenderer } = require('electron')

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
