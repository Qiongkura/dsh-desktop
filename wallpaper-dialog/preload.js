'use strict'

/**
 * 壁纸模糊调节对话框的 preload：
 *  - preview(value)：拖动滑块实时预览（主进程即时更新 CSS 变量）
 *  - commit(value, ok)：确定（保存）或取消（还原）
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshWallpaperDialog', {
  preview: (value) => ipcRenderer.send('dsh:wallpaper-blur-preview', Number(value)),
  commit: (value, ok) => ipcRenderer.send('dsh:wallpaper-blur-commit', { value: Number(value), ok: !!ok }),
})
