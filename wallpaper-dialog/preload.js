'use strict'

/**
 * 壁纸设置对话框的 preload：
 *  - preview({blur, codeAlpha})：滑块实时预览
 *  - commit({ok, blur, codeAlpha})：确定（保存）或取消（还原）
 *  - pickImage() / clearImage()：对话框内更换/清除壁纸图片
 *  - onImageChosen(cb)：主进程把选图结果回传给对话框
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshWallpaperDialog', {
  preview: (payload) => ipcRenderer.send('dsh:wallpaper-preview', payload),
  commit: (payload) => ipcRenderer.send('dsh:wallpaper-commit', payload),
  pickImage: () => ipcRenderer.send('dsh:wallpaper-pick-image'),
  clearImage: () => ipcRenderer.send('dsh:wallpaper-clear-image'),
  onImageChosen: (callback) => {
    ipcRenderer.on('dsh:wallpaper-image-chosen', (_event, file) => callback(file))
  },
})
