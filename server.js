// 生产服务器：复用 vite.config.ts 的 /api 中间件（高德/DEM/OSM/天气/氢耗预测），
// 并伺服 dist/ 静态产物（含 SPA 回退与 /physics-lab.html）。
// 运行：先 npm run build，再 node server.js（可用 PM2 守护）。
import { createServer as createViteServer } from 'vite'
import { createServer as createHttpServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
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
  const urlPath = (req.url || '/').split('?')[0]
  if (urlPath.startsWith('/api/')) {
    // API 交给 vite 中间件；没命中则 404
    vite.middlewares.handle(req, res, () => { res.statusCode = 404; res.end('not found') })
    return
  }
  serveStatic(req, res)
})

server.listen(PORT, '0.0.0.0', () => {
  console.log('[prod] 新线路氢耗预测工具已启动: http://0.0.0.0:' + PORT)
  console.log('[prod] 需 Python（模型预测）: 请在 .env 或环境变量设置 PYTHON（如 /path/.venv/bin/python）')
})