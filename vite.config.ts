import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync as fsRead } from 'node:fs'
import { existsSync as fsExists } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { fetchRoutePlan, fetchRouteWithSegments } from './src/route/amapRoute'
import { loadStations } from './src/route/stationLayer'
import { enrichSegmentsWithDem } from './src/route/demFetch'
import { summarizeSegments } from './src/route/segment'
import { evaluateRoute, getAiConfig } from './src/route/ai'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 加载 .env（系统环境变量优先，不覆盖已有值） */
try {
  const envPath = join(__dirname, '.env')
  if (fsExists(envPath)) {
    for (const line of fsRead(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  }
} catch {}


function send(res: any, code: number, obj: unknown) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}


/* ===== DEM 提取任务管理（前端进度条用） ===== */
interface DemJob {
  id: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  phase: string
  done: number
  total: number
  cached: number
  result?: unknown
  error?: string
  createdAt: number
}
const demJobs = new Map<string, DemJob>()
let demJobSeq = 0
/** 已结束任务的保留时长：任务只在 /result 或 /cancel 被访问时才删除，
 * 客户端轮到 status=done 就离开的话没人来取结果，而每个 job 里存着整条路线的
 * 分段数据（含逐点坐标与剖面，可达数 MB），不清理就是纯内存泄漏 */
const DEM_JOB_TTL_MS = 10 * 60 * 1000
/** 运行中任务的上限年龄（异常卡住的任务也要能回收） */
const DEM_JOB_MAX_AGE_MS = 30 * 60 * 1000

function pruneDemJobs() {
  const now = Date.now()
  for (const [id, j] of demJobs) {
    const age = now - j.createdAt
    if (age > (j.status === 'running' ? DEM_JOB_MAX_AGE_MS : DEM_JOB_TTL_MS)) demJobs.delete(id)
  }
}

function startDemJob(origin: string, destination: string, index: number) {
  pruneDemJobs()
  const id = 'dem_' + Date.now() + '_' + ++demJobSeq
  const job: DemJob = { id, status: 'running', phase: 'route', done: 0, total: 0, cached: 0, createdAt: Date.now() }
  demJobs.set(id, job)
  ;(async () => {
    try {
      const { candidate, segments } = await fetchRouteWithSegments(origin, destination, index)
      if (job.status === 'cancelled') return
      job.phase = 'dem'
      const enriched = await enrichSegmentsWithDem(segments, {
        cacheDir: join(__dirname, 'data', 'dem-cache'),
        onProgress: (p) => {
          if (job.status === 'cancelled') return
          job.phase = p.phase
          job.done = p.done
          job.total = p.total
          job.cached = p.cached
        },
      })
      if (job.status === 'cancelled') return
      job.phase = 'compute'
      job.result = {
        candidate,
        segments: enriched.segments,
        summary: summarizeSegments(enriched.segments),
        dem: { z: enriched.z, tiles: enriched.tilesUsed, source: enriched.source },
      }
      job.status = 'done'
    } catch (e: any) {
      job.status = 'error'
      job.error = e.message || String(e)
    }
  })()
  return job
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk: Buffer) => { data += chunk.toString('utf8') })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })
}

const CITY_TABLE: Record<string, string> = {
  北京: '116.407,39.904', 天津: '117.19,39.13', 上海: '121.473,31.23',
  广州: '113.264,23.129', 深圳: '114.057,22.543', 乌兰察布: '113.13,40.99',
  呼和浩特: '111.75,40.84', 大同: '113.3,40.08', 石家庄: '114.51,38.04',
  唐山: '118.18,39.63', 济南: '117.12,36.65', 青岛: '120.38,36.07',
  郑州: '113.62,34.75', 武汉: '114.3,30.59', 西安: '108.94,34.34',
  成都: '104.07,30.67', 重庆: '106.55,29.56', 杭州: '120.15,30.28',
  南京: '118.78,32.06', 沈阳: '123.43,41.8', 长春: '125.32,43.82',
  哈尔滨: '126.53,45.8', 太原: '112.55,37.87', 银川: '106.23,38.49',
  兰州: '103.83,36.06', 西宁: '101.78,36.62', 乌鲁木齐: '87.62,43.83',
  拉萨: '91.14,29.65', 昆明: '102.83,24.88', 贵阳: '106.63,26.65',
  南宁: '108.32,22.82', 海口: '110.32,20.03', 福州: '119.3,26.08',
  厦门: '118.09,24.48', 南昌: '115.86,28.68', 长沙: '112.94,28.23',
  合肥: '117.28,31.86', 佛山: '113.12,23.02', 东莞: '113.75,23.02',
  中山: '113.39,22.52', 珠海: '113.57,22.27',
}

/** 城市表兜底匹配：addr 含城市名，或 addr 本身是城市名的一部分（后者要求 ≥2 字，
 * 否则"海"会命中"上海"、"京"会命中"北京"，把一个无效输入静默定位到某个城市中心） */
function matchCity(addr: string): [string, string] | undefined {
  if (!addr) return undefined
  return Object.entries(CITY_TABLE).find(([city]) =>
    addr.includes(city) || (addr.length >= 2 && city.includes(addr)))
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'api-middleware',
      configureServer(server) {
        server.middlewares.use('/api', async (req: any, res: any) => {
          const url = new URL(req.url || '', 'http://localhost')
          const path = url.pathname
          const key = process.env.AMAP_KEY || ''
          try {
            if (path === '/suggest') {
              const kw = url.searchParams.get('keywords') || ''
              if (!key) return send(res, 200, { ok: false, msg: '未配置 AMAP_KEY' })
              const r = await fetch('https://restapi.amap.com/v3/assistant/inputtips?keywords=' + encodeURIComponent(kw) + '&key=' + key, { signal: AbortSignal.timeout(15000) })
              const j: any = await r.json()
              const tips = (j.tips || []).filter((t: any) => t.location).map((t: any) => ({ name: t.name, district: t.district || '', location: t.location }))
              return send(res, 200, { ok: true, source: 'amap-inputtips', tips: tips.slice(0, 8) })
            }
            if (path === '/geocode') {
              const addr = (url.searchParams.get('address') || '').trim()
              // ① 优先高德地理编码：精确到门址/POI（实测 key 支持，返回 level=门牌号/门址/公交站点等）
              if (key) {
                const r = await fetch('https://restapi.amap.com/v3/geocode/geo?address=' + encodeURIComponent(addr) + '&key=' + key, { signal: AbortSignal.timeout(15000) })
                const j: any = await r.json()
                if (j.status === '1' && j.geocodes && j.geocodes[0] && j.geocodes[0].location) {
                  return send(res, 200, { ok: true, source: 'amap-geocode', name: j.geocodes[0].formatted_address || addr, location: j.geocodes[0].location })
                }
                // ② 高德失败（如权限/配额问题）→ 回退内置城市表（城市中心点），并明确标注
                const hit = matchCity(addr)
                if (hit) return send(res, 200, { ok: true, source: 'local-table', name: hit[0] + '（城市中心）', location: hit[1] })
                return send(res, 200, { ok: false, msg: '地理编码失败：' + (j.info || '未知错误') + '（可在高德控制台为 Key 开通"地理编码"权限）' })
              }
              // ③ 无 Key：仅内置城市表兜底
              const hit = matchCity(addr)
              if (hit) return send(res, 200, { ok: true, source: 'local-table', name: hit[0], location: hit[1] })
              return send(res, 200, { ok: false, msg: '未配置 AMAP_KEY' })
            }
            if (path === '/route') {
              const origin = url.searchParams.get('origin') || ''
              const destination = url.searchParams.get('destination') || ''
              if (!origin || !destination) return send(res, 400, { ok: false, msg: '缺少 origin/destination' })
              if (!key) return send(res, 200, { ok: false, msg: '未配置 AMAP_KEY' })
              const plan = await fetchRoutePlan(origin, destination)
              return send(res, 200, { ok: true, stations: loadStations(join(__dirname, 'data', 'stations.geojson')), routes: plan.routes })
            }
            if (path === '/stations') {
              return send(res, 200, { ok: true, stations: loadStations(join(__dirname, 'data', 'stations.geojson')) })
            }
            if (path === '/segments') {
              const origin = url.searchParams.get('origin') || ''
              const destination = url.searchParams.get('destination') || ''
              const index = Number(url.searchParams.get('index') || 0)
              if (!origin || !destination) return send(res, 400, { ok: false, msg: '缺少 origin/destination' })
              if (!key) return send(res, 200, { ok: false, msg: '未配置 AMAP_KEY' })
              const { candidate, segments } = await fetchRouteWithSegments(origin, destination, index)
              const enriched = await enrichSegmentsWithDem(segments, { cacheDir: join(__dirname, 'data', 'dem-cache') })
              const summary = summarizeSegments(enriched.segments)
              return send(res, 200, {
                ok: true,
                candidate,
                segments: enriched.segments,
                summary,
                dem: { z: enriched.z, tiles: enriched.tilesUsed, source: enriched.source },
              })
            }
            if (path === '/ai/evaluate' && req.method === 'POST') {
              let cfg
              try { cfg = getAiConfig() } catch (e: any) {
                return send(res, 200, { ok: false, msg: (e.message || e) + '。请在环境变量/.env 中配置 DEEPSEEK_API_KEY' })
              }
              let body: any = {}
              try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* 非法 JSON 按空处理 */ }
              const { origin, destination, candidate, segments, summary } = body
              if (!candidate || !Array.isArray(segments) || !segments.length) {
                return send(res, 400, { ok: false, msg: '缺少候选路线/路段数据' })
              }
              // summary 缺失时就地汇总：拼 prompt 时会直接读 summary.segmentCount，
              // 少这个字段会抛 TypeError，用户只看到 500 而不是可读的原因
              const sum = summary ?? summarizeSegments(segments)
              try {
                const r = await evaluateRoute({ origin, destination, candidate, segments, summary: sum }, cfg)
                return send(res, 200, { ok: true, text: r.text, model: r.model })
              } catch (e: any) {
                return send(res, 200, { ok: false, msg: e.message || String(e) })
              }
            }
            if (path === '/segments/start') {
              let payload: any = {}
              try { payload = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
              const origin = payload.origin || ''
              const destination = payload.destination || ''
              const index = Number(payload.index || 0)
              if (!origin || !destination) return send(res, 400, { ok: false, msg: '缺少 origin/destination' })
              if (!key) return send(res, 200, { ok: false, msg: '未配置 AMAP_KEY' })
              const job = startDemJob(origin, destination, index)
              return send(res, 200, { ok: true, jobId: job.id, status: job.status })
            }
            if (path === '/segments/status') {
              const id = url.searchParams.get('jobId') || ''
              const job = demJobs.get(id)
              if (!job) return send(res, 200, { ok: false, msg: '任务不存在或已过期' })
              return send(res, 200, { ok: true, status: job.status, phase: job.phase, done: job.done, total: job.total, cached: job.cached, error: job.error })
            }
            if (path === '/segments/result') {
              const id = url.searchParams.get('jobId') || ''
              const job = demJobs.get(id)
              if (!job) return send(res, 200, { ok: false, msg: '任务不存在或已过期' })
              if (job.status !== 'done') return send(res, 200, { ok: false, status: job.status, msg: '任务未完成' })
              const result = job.result
              demJobs.delete(id)
              return send(res, 200, { ok: true, ...(result as object) })
            }
            if (path === '/segments/cancel') {
              let payload: any = {}
              try { payload = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
              const job = demJobs.get(payload.jobId || '')
              if (job) { job.status = 'cancelled'; demJobs.delete(payload.jobId) }
              return send(res, 200, { ok: true })
            }
            return send(res, 404, { ok: false, msg: 'unknown api: ' + path })
          } catch (e: any) {
            return send(res, 500, { ok: false, msg: 'server error: ' + (e.message || e) })
          }
        })
      },
    },
  ],
  server: { port: 5174, host: true },
})
