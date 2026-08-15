'use strict'

/**
 * 关闭确认对话框的 preload：把「选择结果」通过 contextBridge 暴露给页面，
 * 页面按钮 / 快捷键调用 window.dshCloseDialog.choose(action)，主进程据此
 * 决定隐藏到托盘还是退出。
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshCloseDialog', {
  choose: (action) => ipcRenderer.send('dsh:close-dialog-action', action),
})
