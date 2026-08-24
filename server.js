// 生产服务器：复用 vite.config.ts 的 /api 中间件（高德/DEM/OSM/天气/氢耗预测），
// 并伺服 dist/ 静态产物（含 SPA 回退与 /physics-lab.html）。
// 运行：先 npm run build，再 node server.js（可用 PM2 守护）。
import { createServer as createViteServer } from 'vite'
import { createServer as createHttpServer } from 'node:http'
import { readFileSync, existsSync, statSync, appendFile } from 'node:fs'
import { createGzip } from 'node:zlib'
import { extname, join, dirname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST = join(__dirname, 'dist')
const PORT = Number(process.env.PORT || 5174)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
}

/** 访问日志：记录时间 / 来源 IP / 方法 / 路径 / 状态码 / UA，写入 data/access.log（*.log 已被 gitignore）。
 * 无反向代理时 req.socket.remoteAddress 即客户端公网 IP，可用于判断访客地域（如评审 IP 归属）。 */
function logAccess(req, res, urlPath) {
  res.on('finish', () => {
    try {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '-'
      const ua = (req.headers['user-agent'] || '').slice(0, 120).replace(/"/g, "'")
      const line = new Date().toISOString() + ' ' + ip + ' ' + req.method + ' ' + urlPath + ' ' + res.statusCode + ' "' + ua + '"\n'
      appendFile(join(__dirname, 'data', 'access.log'), line, () => {})
    } catch (e) {}
  })
}

/** gzip 压缩中间件：客户端接受 gzip 且响应为文本类（html/json/js/css/md/txt/svg）时压缩。
 * 长路线预测/报告 JSON 响应可达数 MB，不压缩在跨国不稳定的链路上极易被截断
 * （前端表现为 Failed to fetch / Unexpected end of JSON input）。gzip 后体积缩小 10~20 倍。 */
function maybeGzip(req, res, next) {
  const accept = String(req.headers['accept-encoding'] || '')
  if (req.method === 'HEAD' || !/\bgzip\b/i.test(accept)) return next()
  const origWrite = res.write.bind(res)
  const origEnd = res.end.bind(res)
  let gzip = null
  const ensure = () => {
    if (gzip) return gzip
    const ct = String(res.getHeader('Content-Type') || '')
    // 图片/音频/视频/字体本身已压缩，再 gzip 只会更慢
    if (/^(image|audio|video|font)\//.test(ct)) return null
    gzip = createGzip()
    res.setHeader('Content-Encoding', 'gzip')
    res.removeHeader('Content-Length')
    gzip.on('data', (c) => { try { origWrite(c) } catch (e) {} })
    gzip.on('end', () => { try { origEnd() } catch (e) {} })
    gzip.on('error', () => { try { origEnd() } catch (e) {} })
    return gzip
  }
  res.write = function (chunk, ...rest) {
    const g = ensure()
    if (g) { try { g.write(chunk) } catch (e) { return origWrite(chunk, ...rest) } return true }
    return origWrite(chunk, ...rest)
  }
  res.end = function (chunk, ...rest) {
    const g = ensure()
    if (g) {
      try {
        if (chunk !== undefined && chunk !== null) g.write(chunk)
        g.end()
      } catch (e) { try { origEnd(chunk, ...rest) } catch (e2) {} }
      return this
    }
    return origEnd(chunk, ...rest)
  }
  return next()
}

/** 静态文件 + SPA 回退（带目录穿越防护） */
function serveStatic(req, res) {
  const raw = (req.url || '/').split('?')[0]
  const urlPath = decodeURIComponent(raw)
  let filePath = normalize(join(DIST, urlPath === '/' ? 'index.html' : urlPath))
  if (!filePath.startsWith(normalize(DIST))) { res.statusCode = 403; return res.end('forbidden') }
  let final = filePath
  try {
    if (!existsSync(final) || statSync(final).isDirectory()) {
      if (extname(urlPath)) { res.statusCode = 404; return res.end('not found') }
      final = join(DIST, 'index.html') // SPA 回退
    }
    const data = readFileSync(final)
    res.statusCode = 200
    res.setHeader('Content-Type', MIME[extname(final).toLowerCase()] || 'application/octet-stream')
    res.setHeader('Cache-Control', extname(final) === '.html' ? 'no-cache' : 'public, max-age=86400')
    res.end(data)
  } catch (e) {
    res.statusCode = 500
    res.end('server error: ' + ((e && e.message) || e))
  }
}

// 以 middlewareMode 复用 vite.config.ts（其插件在 configureServer 里注册了全部 /api/*）
const vite = await createViteServer({
  root: __dirname,
  configFile: join(__dirname, 'vite.config.ts'),
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
})

const server = createHttpServer((req, res) => {
  // 客户端中途断开时吞掉 req/res 错误，避免 unhandled 'error' 崩溃（write EOF / ECONNRESET）
  req.on('error', () => {})
  res.on('error', () => {})
  const urlPath = (req.url || '/').split('?')[0]
  logAccess(req, res, urlPath)
  maybeGzip(req, res, () => {
    if (urlPath.startsWith('/api/')) {
      // API 交给 vite 中间件；没命中则 404
      vite.middlewares.handle(req, res, () => { res.statusCode = 404; res.end('not found') })
      return
    }
    serveStatic(req, res)
  })
})

// 畸形请求 / 客户端断开兜底：吞掉 socket 错误，防止未处理 'error' 事件击穿进程
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  else socket.destroy()
})
server.on('connection', (socket) => { socket.on('error', () => {}) })

server.listen(PORT, '0.0.0.0', () => {
  console.log('[prod] 新线路氢耗预测工具已启动: http://0.0.0.0:' + PORT)
  console.log('[prod] 需 Python（模型预测）: 请在 .env 或环境变量设置 PYTHON（如 /path/.venv/bin/python）')
})