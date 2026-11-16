import { spawn } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync as fsRead } from 'node:fs'
import { existsSync as fsExists } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { fetchRoutePlan, fetchRouteWithSegments } from './src/route/amapRoute'
import { loadStations } from './src/route/stationLayer'
import { enrichSegmentsWithDem } from './src/route/demFetch'
import { enrichSegmentsWithOsmRoads } from './src/route/osmRoad'
import { enrichSegmentsWithWeather } from './src/route/weather'
import { summarizeSegments } from './src/route/segment'
import { evaluateRoute, getAiConfig, recommendRoute } from './src/route/ai'

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

/** 加氢站是静态文件，进程内不会变：只读盘解析一次，避免每个请求都重新 parse 153KB geojson */
let stationsCache: ReturnType<typeof loadStations> | null = null
function cachedStations() {
  if (!stationsCache) stationsCache = loadStations(join(__dirname, 'data', 'stations.geojson'))
  return stationsCache
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
/** 已结束的任务保留时长：结果可重复获取（刷新页面不丢），过期后清理避免长跑 dev server 堆积 */
const DEM_JOB_TTL_MS = 10 * 60 * 1000

function sweepDemJobs() {
  const now = Date.now()
  for (const [id, j] of demJobs) {
    if (j.status !== 'running' && now - j.createdAt > DEM_JOB_TTL_MS) demJobs.delete(id)
  }
  // 已完成任务数上限：大路线段数据（含坐标）驻留内存很贵，超过 12 个就清理最老的
  const done = [...demJobs.entries()]
    .filter(([, j]) => j.status !== 'running')
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
  const MAX_FINISHED_JOBS = 12
  while (done.length > MAX_FINISHED_JOBS) {
    const [id] = done.shift()!
    demJobs.delete(id)
  }
}

/* ===== 动态规划任务（路线 + 车速 + 氢电双补能 DP） ===== */
interface PlanJob {
  id: string
  status: 'running' | 'done' | 'error'
  phase: string
  createdAt: number
  result?: unknown
  error?: string
}
const planJobs = new Map<string, PlanJob>()
let planJobSeq = 0
const PLAN_JOB_TTL_MS = 15 * 60 * 1000
function sweepPlanJobs() {
  const now = Date.now()
  for (const [id, j] of planJobs) {
    if (j.status !== 'running' && now - j.createdAt > PLAN_JOB_TTL_MS) planJobs.delete(id)
  }
}
function startPlanJob(origin: string, destination: string, lambda: number, opts: any = {}) {
  const id = 'plan_' + Date.now() + '_' + ++planJobSeq
  const job: PlanJob = { id, status: 'running', phase: '路线与数据准备中', createdAt: Date.now() }
  planJobs.set(id, job)
  const outRel = `output/plan_${id}.json`
  const outAbs = join(__dirname, outRel)
  const tsxCli = join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const child = spawn(process.execPath, [
    tsxCli, join('scripts', 'dynamic_plan.ts'), origin, destination,
    `--lambda=${lambda}`, `--out=${outRel}`,
    `--replan-at=${opts.replanAt ?? 40}`,
    `--replan-len=${opts.replanLen ?? 50}`,
    `--replan-speed=${opts.replanSpeed ?? 0.7}`,
    `--replan-consume=${opts.replanConsume ?? 1}`,
  ], { cwd: __dirname })
  let err = ''
  child.stdout.on('data', (d: Buffer) => {
    const m = d.toString('utf8').match(/\[plan\]\s*(.+)/)
    if (m) job.phase = m[1].trim().slice(0, 80)
  })
  child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
  child.on('close', (code: number) => {
    if (code === 0) {
      try {
        job.result = JSON.parse(fsRead(outAbs, 'utf8'))
        job.status = 'done'
        job.phase = '完成'
      } catch (e: any) {
        job.status = 'error'
        job.error = '读取规划结果失败: ' + (e?.message || e)
      }
    } else {
      job.status = 'error'
      job.error = (err || 'tsx exit ' + code).slice(0, 400)
    }
  })
  child.on('error', (e: Error) => {
    job.status = 'error'
    job.error = e.message
  })
  return job
}

/* ===== 实时监控：每 N 秒轮询高德路况，偏差超阈值自动触发重规划 ===== */
interface MonitorEvent {
  time: string
  type: 'info' | 'deviation' | 'replan'
  message: string
  deltaMin?: number
}
interface MonitorJob {
  id: string
  status: 'running' | 'stopped'
  origin: string
  destination: string
  lambda: number
  intervalSec: number
  baselineDurationH: number
  baselineDistanceKm: number
  currentDurationH: number
  currentDistanceKm: number
  events: MonitorEvent[]
  lastPollAt: number
  nextPollAt: number
  lastReplanJobId?: string
  timer?: ReturnType<typeof setTimeout>
  createdAt: number
}
const monitorJobs = new Map<string, MonitorJob>()
let monitorSeq = 0
const DEVIATION_THRESHOLD_MIN = 10

function startMonitorJob(origin: string, destination: string, lambda: number, intervalSec: number) {
  const id = 'mon_' + Date.now() + '_' + ++monitorSeq
  const job: MonitorJob = {
    id, status: 'running', origin, destination, lambda, intervalSec,
    baselineDurationH: 0, baselineDistanceKm: 0, currentDurationH: 0, currentDistanceKm: 0,
    events: [], lastPollAt: 0, nextPollAt: Date.now(), createdAt: Date.now(),
  }
  monitorJobs.set(id, job)
  const nowText = () => new Date().toLocaleTimeString('zh-CN')
  const poll = async () => {
    if (job.status !== 'running') return
    try {
      // noCache：绕过 10 分钟路线缓存，保证轮询拿到最新路况
      const plan = await fetchRoutePlan(origin, destination, { noCache: true })
      const cur = plan.routes[0]
      if (!cur) throw new Error('无可用路线')
      job.currentDurationH = cur.durationH
      job.currentDistanceKm = cur.distanceKm
      if (!job.baselineDurationH) {
        job.baselineDurationH = cur.durationH
        job.baselineDistanceKm = cur.distanceKm
        job.events.push({ time: nowText(), type: 'info', message: `基线建立：${cur.distanceKm}km / ${cur.durationH}h` })
      } else {
        const deltaMin = (cur.durationH - job.baselineDurationH) * 60
        if (deltaMin >= DEVIATION_THRESHOLD_MIN) {
          job.events.push({
            time: nowText(), type: 'deviation', deltaMin: Number(deltaMin.toFixed(1)),
            message: `路况恶化：预计延误 +${deltaMin.toFixed(1)} 分钟（当前 ${cur.durationH.toFixed(2)}h vs 基线 ${job.baselineDurationH.toFixed(2)}h），超过阈值 ${DEVIATION_THRESHOLD_MIN} 分钟`,
          })
          // 自动触发重规划（异步后台跑，避免阻塞轮询）
          const pj = startPlanJob(origin, destination, lambda, { replanAt: 20, replanSpeed: 0.7 })
          job.lastReplanJobId = pj.id
          job.events.push({ time: nowText(), type: 'replan', message: `已自动触发重规划（任务 ${pj.id}）` })
        } else {
          job.events.push({ time: nowText(), type: 'info', message: `路况正常：延误 ${deltaMin.toFixed(1)} 分钟（阈值 ${DEVIATION_THRESHOLD_MIN} 分钟）` })
        }
      }
      job.lastPollAt = Date.now()
    } catch (e: any) {
      job.events.push({ time: nowText(), type: 'info', message: '轮询失败：' + (e?.message || e) })
    }
    if (job.events.length > 60) job.events.splice(0, job.events.length - 60)
    job.nextPollAt = Date.now() + intervalSec * 1000
    if (job.status === 'running') job.timer = setTimeout(poll, intervalSec * 1000)
  }
  poll()
  return job
}

function startDemJob(origin: string, destination: string, index: number, departureTime?: string) {
  const id = 'dem_' + Date.now() + '_' + ++demJobSeq
  const job: DemJob = { id, status: 'running', phase: 'route', done: 0, total: 0, cached: 0, createdAt: Date.now() }
  demJobs.set(id, job)
  // 换阶段时把计数清零：只改 phase 会让新阶段沿用上一阶段的 done/total，
  // 进度条先停在 100% 再跳回 0%，来回三四轮，看着像卡死了
  const enterPhase = (phase: string) => {
    if (job.status === 'cancelled') return
    job.phase = phase
    job.done = 0
    job.total = 0
    job.cached = 0
  }
  ;(async () => {
    try {
      const { candidate, segments } = await fetchRouteWithSegments(origin, destination, index)
      if (job.status === 'cancelled') return
      enterPhase('dem')
      const enriched = await enrichSegmentsWithDem(segments, {
        cacheDir: join(__dirname, 'data', 'dem-cache'),
        shouldCancel: () => job.status === 'cancelled',
        onProgress: (p) => {
          if (job.status === 'cancelled') return
          job.phase = p.phase
          job.done = p.done
          job.total = p.total
          job.cached = p.cached
        },
      })
      if (job.status === 'cancelled') return
      // OSM 真实路网升级道路等级（无匹配/服务不可用时自动保留规则推断，不阻塞主流程）
      enterPhase('osm-query')
      const osmRes = await enrichSegmentsWithOsmRoads(enriched.segments, {
        cacheDir: join(__dirname, 'data', 'osm-cache'),
        shouldCancel: () => job.status === 'cancelled',
        onProgress: (p) => {
          if (job.status === 'cancelled') return
          job.phase = p.phase
          job.done = p.done
          job.total = p.total
          job.cached = 0
        },
      })
      if (job.status === 'cancelled') return
      // 天气：按出发时间 + 位置 + 时刻匹配沿线温度/风速/湿度/降水（QWeather 主源，高德兜底；无 key 自动跳过）
      enterPhase('weather')
      const weatherRes = await enrichSegmentsWithWeather(osmRes.segments, {
        cacheDir: join(__dirname, 'data', 'weather-cache'),
        departureTime,
        shouldCancel: () => job.status === 'cancelled',
        onProgress: (p) => {
          if (job.status === 'cancelled') return
          job.phase = p.phase
          job.done = p.done
          job.total = p.total
          job.cached = 0
        },
      })
      if (job.status === 'cancelled') return
      enterPhase('compute')
      job.result = {
        candidate,
        segments: weatherRes.segments,
        summary: summarizeSegments(weatherRes.segments),
        dem: { z: enriched.z, tiles: enriched.tilesUsed, source: enriched.source },
        osm: { queries: osmRes.queries, coveredKm: osmRes.osmCoveredKm, fallbackKm: osmRes.ruleFallbackKm },
        weather: { provider: weatherRes.provider, sampled: weatherRes.sampled, unmatched: weatherRes.unmatched, bySource: weatherRes.bySource, queries: weatherRes.queries, windySegments: weatherRes.windySegments },
      }
      job.status = 'done'
    } catch (e: any) {
      if (job.status === 'cancelled') return // 用户取消导致的中断，不算失败
      job.status = 'error'
      job.error = e.message || String(e)
    }
  })()
  return job
}

/** 调 python 预测脚本（stdin/stdout JSON；cwd=ml/） */
function runPythonScript(script: string, input: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Windows 默认 python；Linux/macOS 默认 python3（PR#12 曾改为 python3，导致 Windows 上 python3 为商店占位符而预测失败）
    const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
    const child = spawn(py, [script], { cwd })
    let out = '', err = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8') })
    child.on('close', (code: number) => resolve({ code, stdout: out, stderr: err }))
    child.on('error', (e: Error) => resolve({ code: -1, stdout: out, stderr: e.message }))
    child.stdin.write(input)
    child.stdin.end()
  })
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

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'api-middleware',
      configureServer(server) {
        server.middlewares.use('/api', async (req: any, res: any) => {
          // 客户端中途断开时吞掉 req/res 错误，避免 unhandled 'error' 崩溃（write EOF / ECONNRESET）
          req.on('error', () => {})
          res.on('error', () => {})
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
              // 空地址必须直接挡掉：下面城市表匹配用的 city.includes(addr)，对空串恒为 true，
              // 会静默命中表里第一项（北京），演示时清空输入框仍会规划出一条"从北京出发"的路线
              if (!addr) return send(res, 200, { ok: false, msg: '请输入起点/终点地址' })
              // ① 优先高德地理编码：精确到门址/POI（实测 key 支持，返回 level=门牌号/门址/公交站点等）
              if (key) {
                const r = await fetch('https://restapi.amap.com/v3/geocode/geo?address=' + encodeURIComponent(addr) + '&key=' + key, { signal: AbortSignal.timeout(15000) })
                const j: any = await r.json()
                if (j.status === '1' && j.geocodes && j.geocodes[0] && j.geocodes[0].location) {
                  return send(res, 200, { ok: true, source: 'amap-geocode', name: j.geocodes[0].formatted_address || addr, location: j.geocodes[0].location })
                }
                // ② 高德失败（如权限/配额问题）→ 回退内置城市表（城市中心点），并明确标注
                const hit = Object.entries(CITY_TABLE).find(([city]) => addr.includes(city) || city.includes(addr))
                if (hit) return send(res, 200, { ok: true, source: 'local-table', name: hit[0] + '（城市中心）', location: hit[1] })
                return send(res, 200, { ok: false, msg: '地理编码失败：' + (j.info || '未知错误') + '（可在高德控制台为 Key 开通"地理编码"权限）' })
              }
              // ③ 无 Key：仅内置城市表兜底
              const hit = Object.entries(CITY_TABLE).find(([city]) => addr.includes(city) || city.includes(addr))
              if (hit) return send(res, 200, { ok: true, source: 'local-table', name: hit[0], location: hit[1] })
              return send(res, 200, { ok: false, msg: '未配置 AMAP_KEY' })
            }
            if (path === '/route') {
              const origin = url.searchParams.get('origin') || ''
              const destination = url.searchParams.get('destination') || ''
              if (!origin || !destination) return send(res, 400, { ok: false, msg: '缺少 origin/destination' })
              if (!key) return send(res, 200, { ok: false, msg: '未配置 AMAP_KEY' })
              const plan = await fetchRoutePlan(origin, destination)
              // 加氢站由前端挂载时单独调 /stations 取一次；这里不再重复下发 571 座站点（约 79KB 白流量）
              return send(res, 200, { ok: true, routes: plan.routes })
            }
            if (path === '/stations') {
              return send(res, 200, { ok: true, stations: cachedStations() })
            }
            if (path === '/segments') {
              const origin = url.searchParams.get('origin') || ''
              const destination = url.searchParams.get('destination') || ''
              const index = Number(url.searchParams.get('index') || 0)
              const departureTime = url.searchParams.get('departureTime') || undefined
              if (!origin || !destination) return send(res, 400, { ok: false, msg: '缺少 origin/destination' })
              if (!key) return send(res, 200, { ok: false, msg: '未配置 AMAP_KEY' })
              const { candidate, segments } = await fetchRouteWithSegments(origin, destination, index)
              const enriched = await enrichSegmentsWithDem(segments, { cacheDir: join(__dirname, 'data', 'dem-cache') })
              const osmRes = await enrichSegmentsWithOsmRoads(enriched.segments, { cacheDir: join(__dirname, 'data', 'osm-cache') })
              const weatherRes = await enrichSegmentsWithWeather(osmRes.segments, { cacheDir: join(__dirname, 'data', 'weather-cache'), departureTime })
              const summary = summarizeSegments(weatherRes.segments)
              return send(res, 200, {
                ok: true,
                candidate,
                segments: weatherRes.segments,
                summary,
                dem: { z: enriched.z, tiles: enriched.tilesUsed, source: enriched.source },
                osm: { queries: osmRes.queries, coveredKm: osmRes.osmCoveredKm, fallbackKm: osmRes.ruleFallbackKm },
                weather: { provider: weatherRes.provider, sampled: weatherRes.sampled, bySource: weatherRes.bySource, queries: weatherRes.queries, windySegments: weatherRes.windySegments },
              })
            }
            if (path === '/predict-hydrogen' && req.method === 'POST') {
              let payload: any = {}
              try { payload = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
              const segs = Array.isArray(payload.segments) ? payload.segments : []
              if (segs.length === 0) return send(res, 400, { ok: false, msg: '缺少 segments（请先完成路段测算）' })
              // 按出发时间推算每段到达小时（hour 特征）
              const dep = payload.departureTime ? new Date(payload.departureTime) : new Date()
              if (Number.isNaN(dep.getTime())) dep.setTime(Date.now())
              let accH = 0
              const enriched = segs.map((s: any) => {
                const hour = new Date(dep.getTime() + accH * 3600000).getHours()
                accH += Number(s.durationH) || 0
                return { ...s, hour }
              })
              const input = JSON.stringify({ departure_hour: dep.getHours(), segments: enriched })
              // 模型选择：ml（机器学习，默认）/ physics（物理模型）/ both（双引擎对比）
              const model = payload.model || 'ml'
              const run = (script: string) => runPythonScript(script, input, join(__dirname, 'ml'))
              if (model === 'both') {
                const [mlR, phR] = await Promise.all([run('predict.py'), run('physics.py')])
                if (mlR.code !== 0 || phR.code !== 0) {
                  return send(res, 200, { ok: false, msg: '双引擎预测失败：' + (mlR.stderr || phR.stderr || '').slice(0, 200) })
                }
                try {
                  return send(res, 200, { ok: true, model: 'both',
                    ml: JSON.parse(mlR.stdout), physics: JSON.parse(phR.stdout) })
                } catch { return send(res, 200, { ok: false, msg: '双引擎返回无法解析' }) }
              }
              const script = model === 'physics' ? 'physics.py' : 'predict.py'
              const r = await run(script)
              if (r.code !== 0) {
                console.error('[predict] python 失败:', r.stderr.slice(0, 500))
                return send(res, 200, { ok: false, msg: '氢耗模型预测失败：' + (r.stderr.slice(0, 200) || 'python exit ' + r.code) })
              }
              try {
                const j = JSON.parse(r.stdout)
                return send(res, 200, { ok: true, model, ...j })
              } catch {
                return send(res, 200, { ok: false, msg: '氢耗模型返回无法解析' })
              }
            }

            if (path === '/ai/evaluate' && req.method === 'POST') {
              let cfg
              try { cfg = getAiConfig() } catch (e: any) {
                return send(res, 200, { ok: false, msg: (e.message || e) + '。请在环境变量/.env 中配置 DEEPSEEK_API_KEY' })
              }
              let body: any = {}
              try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* 非法 JSON 按空处理 */ }
              const { origin, destination, candidate, segments, summary } = body
              if (!candidate || !segments) return send(res, 400, { ok: false, msg: '缺少候选路线/路段数据' })
              try {
                const r = await evaluateRoute({ origin, destination, candidate, segments, summary }, cfg)
                return send(res, 200, { ok: true, text: r.text, model: r.model })
              } catch (e: any) {
                return send(res, 200, { ok: false, msg: e.message || String(e) })
              }
            }
            if (path === '/ai/recommend' && req.method === 'POST') {
              let cfg
              try { cfg = getAiConfig() } catch (e: any) {
                return send(res, 200, { ok: false, msg: (e.message || e) + '。请在环境变量/.env 中配置 DEEPSEEK_API_KEY' })
              }
              let body: any = {}
              try { body = JSON.parse((await readBody(req)) || '{}') } catch { /* 非法 JSON 按空处理 */ }
              const { origin, destination, routes } = body
              if (!Array.isArray(routes) || routes.length < 2) return send(res, 400, { ok: false, msg: '缺少路线对比数据' })
              try {
                const r = await recommendRoute({ origin, destination, routes }, cfg)
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
              const departureTime = typeof payload.departureTime === 'string' && payload.departureTime ? payload.departureTime : undefined
              if (!origin || !destination) return send(res, 400, { ok: false, msg: '缺少 origin/destination' })
              if (!key) return send(res, 200, { ok: false, msg: '未配置 AMAP_KEY' })
              const job = startDemJob(origin, destination, index, departureTime)
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
              sweepDemJobs() // 结果保留到 TTL 到期，可重复获取
              return send(res, 200, { ok: true, ...(job.result as object) })
            }
            if (path === '/segments/cancel') {
              let payload: any = {}
              try { payload = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
              const job = demJobs.get(payload.jobId || '')
              // 保留 job 对象并标记 cancelled：后台下载循环靠读它的 status 才能停下来
              if (job) job.status = 'cancelled'
              sweepDemJobs()
              return send(res, 200, { ok: true })
            }
            // ===== 动态规划：路线 + 车速 + 氢电双补能 DP =====
            if (path === '/plan/start' && req.method === 'POST') {
              let payload: any = {}
              try { payload = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
              const origin = payload.origin || ''
              const destination = payload.destination || ''
              const lambda = Number(payload.lambda ?? 100)
              const opts = {
                replanAt: Number(payload.replanAt ?? 40),
                replanLen: Number(payload.replanLen ?? 50),
                replanSpeed: Number(payload.replanSpeed ?? 0.7),
                replanConsume: Number(payload.replanConsume ?? 1),
              }
              if (!origin || !destination) return send(res, 400, { ok: false, msg: '缺少 origin/destination' })
              sweepPlanJobs()
              const job = startPlanJob(origin, destination, lambda, opts)
              return send(res, 200, { ok: true, jobId: job.id })
            }
            if (path === '/plan/status') {
              const id = url.searchParams.get('jobId') || ''
              const job = planJobs.get(id)
              if (!job) return send(res, 200, { ok: false, msg: '任务不存在或已过期' })
              return send(res, 200, { ok: true, status: job.status, phase: job.phase, error: job.error })
            }
            if (path === '/plan/result') {
              const id = url.searchParams.get('jobId') || ''
              const job = planJobs.get(id)
              if (!job) return send(res, 200, { ok: false, msg: '任务不存在或已过期' })
              if (job.status !== 'done') return send(res, 200, { ok: false, status: job.status, msg: job.error || '任务未完成' })
              return send(res, 200, { ok: true, ...(job.result as object) })
            }
            // ===== 实时监控：每 N 秒轮询路况，偏差超阈值自动重规划 =====
            if (path === '/monitor/start' && req.method === 'POST') {
              let payload: any = {}
              try { payload = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
              const origin = payload.origin || ''
              const destination = payload.destination || ''
              if (!origin || !destination) return send(res, 400, { ok: false, msg: '缺少 origin/destination' })
              const intervalSec = Math.max(10, Number(payload.intervalSec ?? 300))
              const job = startMonitorJob(origin, destination, Number(payload.lambda ?? 100), intervalSec)
              return send(res, 200, { ok: true, jobId: job.id, intervalSec })
            }
            if (path === '/monitor/status') {
              const id = url.searchParams.get('jobId') || ''
              const job = monitorJobs.get(id)
              if (!job) return send(res, 200, { ok: false, msg: '监控任务不存在或已过期' })
              return send(res, 200, {
                ok: true, status: job.status, intervalSec: job.intervalSec,
                baseline: { durationH: job.baselineDurationH, distanceKm: job.baselineDistanceKm },
                current: { durationH: job.currentDurationH, distanceKm: job.currentDistanceKm },
                lastPollAt: job.lastPollAt, nextPollAt: job.nextPollAt,
                events: job.events, lastReplanJobId: job.lastReplanJobId || null,
                thresholdMin: DEVIATION_THRESHOLD_MIN,
              })
            }
            if (path === '/monitor/stop' && req.method === 'POST') {
              let payload: any = {}
              try { payload = JSON.parse((await readBody(req)) || '{}') } catch { /* ignore */ }
              const job = monitorJobs.get(payload.jobId || '')
              if (job) {
                job.status = 'stopped'
                if (job.timer) clearTimeout(job.timer)
              }
              return send(res, 200, { ok: true })
            }
            // ===== 可插拔模型 / 评测集 API（2026-08-28；写操作需上传口令） =====
            const checkUploadAuth = () => {
              const tk = process.env.UPLOAD_TOKEN || ''
              if (!tk) return true
              return (req.headers['x-upload-token'] || '') === tk
            }
            const runPyJson = (script: string, input: any): Promise<any> =>
              new Promise((resolve) => {
                const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
                const child = spawn(py, [script], { cwd: join(__dirname, 'ml') })
                let out = '', err = ''
                child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8') })
                child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8') })
                child.on('close', (code: number) => {
                  try { resolve(JSON.parse(out)) }
                  catch { resolve({ ok: false, msg: '脚本输出异常: ' + (err.slice(0, 200) || 'code ' + code) }) }
                })
                child.on('error', (e: Error) => resolve({ ok: false, msg: '脚本启动失败: ' + e.message }))
                child.stdin.write(JSON.stringify(input)); child.stdin.end()
              })
            // 排行榜缓存（histgb 全量评测约 1~2 分钟，避免前端反复点击重跑）
            const leaderboardCache = new Map<string, { t: number; rows: any }>()

            if (path === '/models' && req.method === 'GET') {
              return send(res, 200, await runPyJson('model_api.py', { op: 'list' }))
            }
            if (path === '/models/import' && req.method === 'POST') {
              if (!checkUploadAuth()) return send(res, 401, { ok: false, needToken: true, msg: '需要上传口令（服务器已开启上传保护）' })
              let body: any = {}; try { body = JSON.parse((await readBody(req)) || '{}') } catch {}
              return send(res, 200, await runPyJson('model_api.py', { op: 'import_zip', data: body.data || '' }))
            }
            if (path === '/evalsets' && req.method === 'GET') {
              return send(res, 200, await runPyJson('eval_api.py', { op: 'list' }))
            }
            if (path === '/evalsets/create' && req.method === 'POST') {
              if (!checkUploadAuth()) return send(res, 401, { ok: false, needToken: true, msg: '需要上传口令（服务器已开启上传保护）' })
              let body: any = {}; try { body = JSON.parse((await readBody(req)) || '{}') } catch {}
              return send(res, 200, await runPyJson('eval_api.py', { op: 'create', id: body.id, name: body.name, csv: body.csv, source: body.source || '' }))
            }
            if (path === '/evalsets/append' && req.method === 'POST') {
              if (!checkUploadAuth()) return send(res, 401, { ok: false, needToken: true, msg: '需要上传口令（服务器已开启上传保护）' })
              let body: any = {}; try { body = JSON.parse((await readBody(req)) || '{}') } catch {}
              return send(res, 200, await runPyJson('eval_api.py', { op: 'append', id: body.id, csv: body.csv }))
            }
            if (path === '/evalsets/leaderboard' && req.method === 'GET') {
              const id = url.searchParams.get('id') || ''
              const hit = leaderboardCache.get(id)
              if (hit && Date.now() - hit.t < 5 * 60 * 1000) return send(res, 200, { ok: true, rows: hit.rows, cached: true })
              const j = await runPyJson('eval_api.py', { op: 'leaderboard', id })
              if (j.ok) leaderboardCache.set(id, { t: Date.now(), rows: j.rows })
              return send(res, 200, j)
            }
            if (path === '/evalsets/download' && req.method === 'GET') {
              const id = url.searchParams.get('id') || ''
              return send(res, 200, await runPyJson('eval_api.py', { op: 'download', id }))
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
