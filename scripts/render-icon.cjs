// 用 Electron 渲染 DSH 官方 favicon 为 512x512 PNG（带 alpha）。
// 用法: npx electron scripts/render-icon.cjs <输出png>
// 图标设计：浅色圆角方块 + 黑色官方标（与 apps/web/public/favicon.svg 亮色
// 模式一致——该 SVG 无 fill，默认黑色，深色模式下才变白）。
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const SIZE = 512
const outFile = process.argv[2]
if (!outFile) {
  console.error('usage: electron scripts/render-icon.cjs <output.png>')
  app.exit(2)
}

// 官方 favicon 路径数据（与仓库同步；apps/web/public/favicon.svg 为 GUI 实际使用）
const faviconPath = 'G:/deepseek-harness/apps/web/public/favicon.svg'
const faviconSvg = fs.readFileSync(faviconPath, 'utf8')
const dMatch = faviconSvg.match(/<path[^>]*\sd="([^"]*)"/)
if (!dMatch) {
  console.error(`cannot parse path from ${faviconPath}`)
  app.exit(2)
}
const d = dMatch[1]

const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="296" height="296" viewBox="0 0 50 50">` +
  `<path d="${d}" fill="#000000"/></svg>`

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html, body { margin:0; padding:0; width:${SIZE}px; height:${SIZE}px; background:transparent; overflow:hidden; }
  .sq { position:absolute; inset:0; border-radius:22%;
        background:linear-gradient(135deg, #FFFFFF 0%, #F2F5FB 55%, #E2E9F5 100%);
        box-shadow: inset 0 0 0 1px rgba(15,23,42,0.10); }
  .mark { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; }
</style></head>
<body><div class="sq"></div><div class="mark">${markSvg}</div></body></html>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    webPreferences: { backgroundThrottling: false },
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((r) => setTimeout(r, 800))
  const image = await win.webContents.capturePage()
  fs.writeFileSync(outFile, image.toPNG())
  console.log(`rendered ${outFile} (${image.getSize().width}x${image.getSize().height})`)
  app.exit(0)
})
