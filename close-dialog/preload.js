'use strict'

/**
 * 关闭确认对话框的 preload：把「选择结果」通过 contextBridge 暴露给页面，
 * 页面按钮 / 快捷键调用 window.dshCloseDialog.choose(action)，主进程据此
 * 决定隐藏到托盘还是退出；应用图标也经 IPC 获取（避免 base64 经 URL 查询串
 * 传递时被 URLSearchParams 把 '+' 解码成空格而损坏）。
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshCloseDialog', {
  choose: (action) => ipcRenderer.send('dsh:close-dialog-action', action),
  getIcon: () => ipcRenderer.invoke('dsh:close-dialog-icon'),
})
