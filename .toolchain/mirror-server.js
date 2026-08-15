// 本地 electron-builder-binaries 镜像：规避 winCodeSign 符号链接解压失败。
// 用法: node mirror-server.js <目录> <端口>
const http = require('http')
const fs = require('fs')
const path = require('path')

const root = process.argv[2]
const port = Number(process.argv[3] || 18765)

const map = {
  '/winCodeSign-2.6.0/winCodeSign-2.6.0.7z': 'winCodeSign-2.6.0.7z',
  '/nsis-3.0.4.1/nsis-3.0.4.1.7z': 'nsis-3.0.4.1.7z',
  '/nsis-resources-3.4.1/nsis-resources-3.4.1.7z': 'nsis-resources-3.4.1.7z',
}

http.createServer((req, res) => {
  const name = map[req.url.split('?')[0]]
  if (!name) {
    console.error(`mirror: MISS ${req.url}`)
    res.writeHead(404)
    res.end('not found')
    return
  }
  const file = path.join(root, name)
  fs.readFile(file, (err, data) => {
    if (err) {
      console.error(`mirror: READ FAIL ${name}: ${err.message}`)
      res.writeHead(500)
      res.end('read fail')
      return
    }
    console.log(`mirror: HIT ${req.url} (${data.length} bytes)`)
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    res.end(data)
  })
}).listen(port, '127.0.0.1', () => console.log(`mirror listening on http://127.0.0.1:${port}`))
