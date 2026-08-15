'use strict'

/**
 * 主窗口 preload：把页面检测到的主题（color-scheme）上报给主进程，
 * 用于同步原生标题栏按钮（最小化/最大化/关闭）的配色。
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__dshChrome', {
  reportScheme: (scheme) => ipcRenderer.send('dsh:chrome-scheme', scheme),
})
