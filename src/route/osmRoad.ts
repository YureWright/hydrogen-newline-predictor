/**
 * OSM 真实道路等级：把"规则推断"的道路等级换成 OpenStreetMap 真实路网数据。
 *
 * 背景：规则推断（segment.ts 的 inferRoadLevel）只能靠路名关键词 + 收费里程猜道路等级，
 * 城市小路 / 无名路段常被归为"其他"。OSM 是真实路网：每条路带 highway 标签
 * （motorway=高速 / trunk=快速路 / primary=国道 / secondary=省道 / tertiary=县道 /
 * residential=市区 …），还有 ref 编号（G6、G112、S24），是"不用推断直接能拿到的真实数据"。
 *
 * 方案（地图匹配 Lite）：
 *   ① 把整条路线折线按累计里程切成 ~40km 走廊分块，每块用 Overpass `around:300`
 *      折线查询，拉回走廊内的 highway 线要素（带几何）；
 *   ② 把每个路段的 WGS-84 折线点吸附到最近 OSM 路段（点-线段距离 ≤150m 且航向平行），
 *      逐点投票；
 *   ③ 每段取命中点数最多的 OSM 路 → 由 highway 标签 + ref/name 编号映射到 RoadLevel；
 *   ④ 无匹配 / 服务不可用 → 保留规则推断值（roadSource='rule'），OSM 只做"升级"不做"误伤"。
 *
 * 数据源：Overpass API（免 Key）。公共镜像限流严重，本模块：
 *   - 4 镜像 failover + 20s 单次超时 + 空结果换镜像重试；
 *   - 请求间间隔 + 5 分钟墙钟预算（超时停止查询，已匹配走廊保留）；
 *   - 结果磁盘缓存到 data/osm-cache/（gitignore），同一走廊二次运行秒回。
 *
 * 坐标系：路线折线已由 GCJ-02 逆转换到 WGS-84（coords.ts，残差 <10m），与 OSM 同系，
 * 150m 吸附半径对"转换残差 + OSM 打点误差"都足够。
 *
 * 运行环境：仅 Node 侧（scripts / vite 中间件），不进入浏览器打包。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RoadLevel, SegmentData } from './types'
import { haversineM } from './dem'

/* ============================ 类型 ============================ */

/** OSM 线要素（只保留匹配需要的字段） */
export interface OsmWay {
  id: number
  tags: Record<string, string>
  /** [lng, lat][]（WGS-84，Overpass out geom 返回） */
  geometry: Array<[number, number]>
}

export interface OsmRoadOptions {
  /** OSM 结果缓存目录（默认 data/osm-cache） */
  cacheDir?: string
  /** 走廊查询缓冲半径 m（默认 300） */
  bufferM?: number
  /** 点-路吸附半径 m（默认 150） */
  matchRadiusM?: number
  /** 走廊分块长度 km（默认 40，过长单查询慢、易超限） */
  chunkKm?: number
  /** 查询折线重采样间距 m（默认 1000，减少 around 点数量） */
  queryStepM?: number
  /** 请求间间隔 ms（默认 1000，公共镜像限流） */
  delayMs?: number
  /** 全部 OSM 查询的墙钟预算 ms（默认 300000=5 分钟，超时停止查询并保留已完成走廊） */
  queryBudgetMs?: number
  /** 取消信号：返回 true 时立即停止并保留已完成结果 */
  shouldCancel?: () => boolean
  /** 进度回调（phase: osm-query / osm-match） */
  onProgress?: (p: { phase: 'osm-query' | 'osm-match'; done: number; total: number }) => void
  /** 是否允许写磁盘缓存（默认 true；测试可关） */
  useCache?: boolean
}

export interface OsmRoadResult {
  segments: SegmentData[]
  /** 本路线匹配到的 OSM 路条数 */
  waysMatched: number
  /** 被 OSM 覆盖的里程 km */
  osmCoveredKm: number
  /** 兜底（规则推断）里程 km */
  ruleFallbackKm: number
  /** 实际发出的 Overpass 请求数（缓存命中不计） */
  queries: number
}

/* ============================ OSM highway → RoadLevel ============================ */

/** 不需要推断、直接由 OSM 标签/编号给出道路等级 */
export function osmTagsToRoadLevel(tags: Record<string, string>): RoadLevel {
  const ref = tags.ref || ''
  const name = tags.name || ''
  const s = name + ' ' + ref
  // 显式关键词（中英文混写兜底）
  if (/高速|高速公路/.test(s)) return 'highway'
  if (/国道/.test(s)) return 'national'
  if (/省道/.test(s)) return 'provincial'
  if (/县道|乡道/.test(s)) return 'county'
  if (/快速路|高架/.test(s)) return 'expressway'
  // 编号规则：G 后 3 位 = 国道（G101~G399）；G 后 1/2/4 位 = 国家高速（G6、G15、G4501）
  if (/^G\d{3}(?!\d)/.test(ref)) return 'national'
  if (/^G\d/.test(ref)) return 'highway'
  if (/^S\d/.test(ref)) return 'provincial' // S：省道
  if (/^X\d/.test(ref)) return 'county'     // X：县道
  // highway 标签（OSM 国际惯例，中国区基本一致）
  switch (tags.highway) {
    case 'motorway':
    case 'motorway_link':
      return 'highway'
    case 'trunk':
    case 'trunk_link':
      return 'expressway' // 快速路 / 一级公路
    case 'primary':
    case 'primary_link':
      return 'national'
    case 'secondary':
    case 'secondary_link':
      return 'provincial'
    case 'tertiary':
    case 'tertiary_link':
      return 'county'
    case 'residential':
    case 'living_street':
    case 'service':
      return 'city'
    case 'unclassified':
    case 'road':
    case 'track':
    default:
      return 'other'
  }
}

/** 只查询这些 highway 值（排除 footway/cycleway 等非机动车道，减返回量） */
const HIGHWAY_FILTER =
  '^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|' +
  'tertiary|tertiary_link|unclassified|residential|living_street|service|road)$'


/** 把 OSM 路聚合成"道路身份"键：ref > name > highway 族。
 * OSM 一条高速公路常被切成几十个短 way（每个 way 只有 1~2km），
 * 若按 way.id 投票会碎成一地、没有单一 way 过置信阈值；
 * 按 ref/name 聚合后，S12 首都机场高速公路的所有 way 归为一组，能正确胜出。 */
export function osmRoadKey(tags: Record<string, string>): string {
  const ref = (tags.ref || '').trim()
  const name = (tags.name || '').trim()
  const h = tags.highway || ''
  const family = h.replace(/_link$/, '')
  const id = ref || name || family || 'unknown'
  return id + '|' + family
}
/* ============================ Overpass 查询 ============================ */

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
]

const UA = 'HydrogenRouteTool/0.1 (study; T05 hydrogen route predictor)'

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 单个走廊分块的 Overpass 查询（镜像 failover + 退避 + 空结果换镜像）
 * 公共镜像很不可靠：连接级丢包（fetch failed）、429/406 限流、超时、空响应都可能发生，
 * 单轮内依次尝试 4 个镜像，0 条路视为可疑继续换镜像；全失败由外层连续失败计数提前止损。 */
async function queryOverpassChunk(
  polyline: Array<[number, number]>,
  bufferM: number,
  timeoutMs: number,
): Promise<OsmWay[]> {
  // 输入 polyline 为 [lng, lat]，Overpass around 语法要求 "lat,lon"
  const around = polyline
    .map(([lng, lat]) => lat.toFixed(6) + ',' + lng.toFixed(6))
    .join(',')
  const q =
    '[out:json][timeout:90];way["highway"~"' + HIGHWAY_FILTER + '"]' +
    '(around:' + bufferM + ',' + around + ');out tags geom;'
  let lastErr: string = ''
  // 单轮 4 镜像 failover（公共服务器慢，2 轮会把 5 分钟预算烧光）
  for (const ep of OVERPASS_ENDPOINTS) {
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), timeoutMs)
        const r = await fetch(ep, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': UA,
          },
          body: new URLSearchParams({ data: q }).toString(),
          signal: ctrl.signal,
        })
        clearTimeout(t)
        if (r.status === 429 || r.status === 406 || r.status === 504) {
          lastErr = 'HTTP ' + r.status
          await sleep(2000)
          continue // 限流/网关错误 → 换镜像
        }
        if (!r.ok) {
          lastErr = 'HTTP ' + r.status
          continue
        }
        const text = await r.text()
        const j = JSON.parse(text) as { elements?: Array<{ type?: string; id?: number; tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }> }> }
        if (!Array.isArray(j.elements)) {
          lastErr = 'overpass 无 elements'
          continue
        }
        const ways: OsmWay[] = []
        for (const el of j.elements) {
          if (el.type !== 'way' || !el.id || !el.tags || !Array.isArray(el.geometry)) continue
          ways.push({
            id: el.id,
            tags: el.tags,
            geometry: el.geometry.map((g) => [g.lon, g.lat] as [number, number]),
          })
        }
        if (ways.length === 0) {
          // 0 条路很可疑（哪怕乡间也有路），可能是服务器异常；记录并换镜像重试
          lastErr = '空结果（0 条路）'
          await sleep(1500)
          continue
        }
        return ways
      } catch (e: any) {
        lastErr = e.message || String(e)
        await sleep(1500)
      }
    }
  throw new Error('Overpass 全部镜像失败: ' + lastErr)
}

/* ============================ 缓存 ============================ */

function cachePath(cacheDir: string, key: string): string {
  return join(cacheDir, key + '.json')
}

function loadCache(cacheDir: string, key: string): OsmWay[] | null {
  try {
    const p = cachePath(cacheDir, key)
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8')) as { ways?: OsmWay[] }
    return Array.isArray(j.ways) ? j.ways : null
  } catch {
    return null
  }
}

function saveCache(cacheDir: string, key: string, ways: OsmWay[]): void {
  try {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cachePath(cacheDir, key), JSON.stringify({ savedAt: new Date().toISOString(), ways }))
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

/** 分块折线 → 稳定缓存 key（sha1），分块坐标不变则缓存命中 */
function chunkKey(polyline: Array<[number, number]>): string {
  return createHash('sha1')
    .update(polyline.map(([lng, lat]) => lng.toFixed(5) + ',' + lat.toFixed(5)).join(';'))
    .digest('hex')
    .slice(0, 20)
}

/** 把整条路线坐标按累计里程切成若干走廊分块（每块一条折线） */
function chunkRouteCoords(
  coords: Array<[number, number]>,
  chunkKm: number,
  queryStepM: number,
): Array<Array<[number, number]>> {
  if (coords.length === 0) return []
  // 先按 queryStep 重采样，减少 around 点数
  const pts: Array<[number, number]> = []
  let acc = 0
  pts.push(coords[0])
  for (let i = 1; i < coords.length; i++) {
    const d = haversineM(coords[i - 1], coords[i])
    acc += d
    if (acc >= queryStepM) {
      pts.push(coords[i])
      acc = 0
    }
  }
  if (pts.length < 2) pts.push(coords[coords.length - 1])
  // 再按累计里程分块
  const chunks: Array<Array<[number, number]>> = []
  let cur: Array<[number, number]> = [pts[0]]
  let curKm = 0
  for (let i = 1; i < pts.length; i++) {
    const d = haversineM(pts[i - 1], pts[i])
    if (curKm + d / 1000 > chunkKm) {
      chunks.push(cur)
      cur = [pts[i - 1], pts[i]] // 与上一块重叠一个点，保证走廊连续
      curKm = 0
    } else {
      cur.push(pts[i])
      curKm += d / 1000
    }
  }
  if (cur.length > 1) chunks.push(cur)
  return chunks
}

/* ============================ 点-路吸附 ============================ */

interface SegRec {
  way: OsmWay
  ax: number
  ay: number
  bx: number
  by: number
}

/** 均匀网格空间索引：cell ~0.003° ≈ 300m */
class GridIndex {
  private cell = 0.003
  private map = new Map<string, SegRec[]>()

  constructor(ways: OsmWay[]) {
    for (const w of ways) {
      const g = w.geometry
      if (g.length < 2) continue
      for (let i = 1; i < g.length; i++) {
        const a = g[i - 1]
        const b = g[i]
        if (!a || !b) continue
        this.insert({ way: w, ax: a[0], ay: a[1], bx: b[0], by: b[1] })
      }
    }
  }

  private cellKey(x: number, y: number): string {
    return x + ',' + y
  }

  private insert(r: SegRec): void {
    // 线段 bbox 覆盖的所有 cell
    const x0 = Math.floor(Math.min(r.ax, r.bx) / this.cell)
    const x1 = Math.floor(Math.max(r.ax, r.bx) / this.cell)
    const y0 = Math.floor(Math.min(r.ay, r.by) / this.cell)
    const y1 = Math.floor(Math.max(r.ay, r.by) / this.cell)
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = this.cellKey(x, y)
        const arr = this.map.get(k)
        if (arr) arr.push(r)
        else this.map.set(k, [r])
      }
    }
  }

  /** 找到 (px,py) 在 radiusM 内最近且航向平行的 OSM 线段 */
  findNearest(
    px: number,
    py: number,
    radiusM: number,
    routeHeadingDeg: number | null,
    maxHeadingDiffDeg = 75,
  ): { rec: SegRec; d: number } | null {
    const cosLat = Math.cos((py * Math.PI) / 180)
    const KX = 111320 * cosLat
    const KY = 110540
    const cx = Math.floor(px / this.cell)
    const cy = Math.floor(py / this.cell)
    const span = Math.ceil(radiusM / (this.cell * 111320 * cosLat)) + 1
    let best: { rec: SegRec; d: number } | null = null
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        const arr = this.map.get(this.cellKey(cx + dx, cy + dy))
        if (!arr) continue
        for (const rec of arr) {
          if (routeHeadingDeg != null) {
            const segHeading = bearingDeg(rec.ax, rec.ay, rec.bx, rec.by)
            const diff = Math.abs(((routeHeadingDeg - segHeading + 540) % 360) - 180)
            if (diff > maxHeadingDiffDeg) continue
          }
          const d = pointSegDistM(px, py, rec, KX, KY)
          if (d <= radiusM && (!best || d < best.d)) {
            best = { rec, d }
          }
        }
      }
    }
    return best
  }
}

/** 点-线段距离（本地米制投影，距离 < 数百米时精度足够） */
function pointSegDistM(px: number, py: number, rec: SegRec, KX: number, KY: number): number {
  const axm = (rec.ax - px) * KX
  const aym = (rec.ay - py) * KY
  const bxm = (rec.bx - px) * KX
  const bym = (rec.by - py) * KY
  const dx = bxm - axm
  const dy = bym - aym
  const len2 = dx * dx + dy * dy
  let t = 0
  if (len2 > 0) t = Math.max(0, Math.min(1, -(axm * dx + aym * dy) / len2))
  const qx = axm + t * dx
  const qy = aym + t * dy
  return Math.sqrt(qx * qx + qy * qy)
}

/** 两点航向（度，0~360，正北 0） */
function bearingDeg(ax: number, ay: number, bx: number, by: number): number {
  const phi1 = (ay * Math.PI) / 180
  const phi2 = (by * Math.PI) / 180
  const dLng = ((bx - ax) * Math.PI) / 180
  const y = Math.sin(dLng) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/* ============================ 主入口 ============================ */

/**
 * 用 OSM 真实路网升级每个路段的道路等级。
 * - 先按走廊分块查询 OSM（磁盘缓存），再逐段吸附匹配；
 * - 命中的段：roadLevel 由 OSM 决定，并写入 osmHighway/osmRef/osmName/roadSource；
 * - 未命中 / 服务不可用：保持原值（规则推断），roadSource='rule'。
 */
export async function enrichSegmentsWithOsmRoads(
  segments: SegmentData[],
  opts: OsmRoadOptions = {},
): Promise<OsmRoadResult> {
  const cacheDir = opts.cacheDir ?? 'data/osm-cache'
  const bufferM = opts.bufferM ?? 300
  const matchRadiusM = opts.matchRadiusM ?? 150
  const chunkKm = opts.chunkKm ?? 40
  const queryStepM = opts.queryStepM ?? 1000
  const delayMs = opts.delayMs ?? 800
  const useCache = opts.useCache ?? true
  const result: OsmRoadResult = { segments, waysMatched: 0, osmCoveredKm: 0, ruleFallbackKm: 0, queries: 0 }

  const allCoords: Array<[number, number]> = []
  for (const s of segments) {
    if (s.coordsWgs84?.length) allCoords.push(...s.coordsWgs84)
  }
  if (allCoords.length < 2) return result

  // ① 走廊分块查询
  const chunks = chunkRouteCoords(allCoords, chunkKm, queryStepM)
  const waysByChunk: Array<{ key: string; ways: OsmWay[] }> = []
  const merged = new Map<number, OsmWay>()
  const tQueryStart = Date.now()
  const queryBudgetMs = opts.queryBudgetMs ?? 300000 // 5 分钟墙钟预算，超时停止查询并保留已完成走廊
  let consecutiveFails = 0
  for (let ci = 0; ci < chunks.length; ci++) {
    if (Date.now() - tQueryStart > queryBudgetMs) {
      console.warn('[osm] 查询超过墙钟预算，停止后续分块（已匹配走廊保留）')
      break
    }
    if (opts.shouldCancel?.()) break
    const key = chunkKey(chunks[ci])
    opts.onProgress?.({ phase: 'osm-query', done: ci, total: chunks.length })
    const cached = useCache ? loadCache(cacheDir, key) : null
    let ways: OsmWay[]
    if (cached) {
      ways = cached
      console.log('[osm] 分块 ' + (ci + 1) + '/' + chunks.length + ' 缓存命中（' + cached.length + ' 条路）')
    } else {
      try {
        ways = await queryOverpassChunk(chunks[ci], bufferM, 20000)
        result.queries += 1
        // 只有非空结果才写缓存：空结果很可能是服务器异常，写缓存会把"无路"永久固化
        if (useCache && ways.length > 0) saveCache(cacheDir, key, ways)
        consecutiveFails = 0
        console.log('[osm] 分块 ' + (ci + 1) + '/' + chunks.length + ' 查询完成（' + ways.length + ' 条路）')
      } catch (e) {
        console.warn('[osm] 分块 ' + (ci + 1) + '/' + chunks.length + ' Overpass 查询失败，保留规则推断:', (e as Error).message)
        consecutiveFails += 1
        // 连续两个分块都查不到（服务器宕/限流）→ 提前结束，不再浪费预算
        if (consecutiveFails >= 2) {
          console.warn('[osm] 连续 ' + consecutiveFails + ' 个分块失败，判定 Overpass 不可用，提前结束（已匹配走廊保留）')
          break
        }
        continue
      }
      if (delayMs > 0) await sleep(delayMs)
    }
    waysByChunk.push({ key, ways })
    for (const w of ways) merged.set(w.id, w)
  }
  opts.onProgress?.({ phase: 'osm-query', done: chunks.length, total: chunks.length })

  // ② 建索引 + 逐段匹配
  const allWays = [...merged.values()]
  const index = new GridIndex(allWays)
  const totalSeg = segments.length
  let matched = 0
  for (let si = 0; si < totalSeg; si++) {
    const s = segments[si]
    opts.onProgress?.({ phase: 'osm-match', done: si, total: totalSeg })
    if (opts.shouldCancel?.()) break
    const coords = s.coordsWgs84 ?? []
    if (coords.length < 2) continue
    // 匝道/收费站/服务区等行为段：路名指向所连接的干线（如"驶出S12机场高速"→高速），
    // OSM 却常把这些短连接段标成 *_link/service（等级更低），会错误降级 → 保持规则推断
    if (s.motionBehavior === 'ramp' || s.motionBehavior === 'toll' || s.motionBehavior === 'serviceArea') continue
    // 投票：按"道路身份键"（ref/name/highway 族）聚合，而不是按 way.id
    const votes = new Map<string, { count: number; dist: number }>()
    const maxPts = Math.min(coords.length, 800)
    for (let i = 0; i < maxPts; i++) {
      const [lng, lat] = coords[Math.floor((i * coords.length) / maxPts)]
      const h0 = i > 0 ? coords[Math.floor(((i - 1) * coords.length) / maxPts)] : null
      const h1 = i < maxPts - 1 ? coords[Math.floor(((i + 1) * coords.length) / maxPts)] : null
      const routeHeading = h0 && h1 ? bearingDeg(h0[0], h0[1], h1[0], h1[1]) : null
      const hit = index.findNearest(lng, lat, matchRadiusM, routeHeading)
      if (!hit) continue
      const key = osmRoadKey(hit.rec.way.tags)
      const v = votes.get(key)
      if (v) {
        v.count += 1
        v.dist += hit.d
      } else {
        votes.set(key, { count: 1, dist: hit.d })
      }
    }
    // 取命中点数最多的道路身份；要求至少 3 个点且占被匹配点的 ≥25%
    let best: { key: string; count: number } | null = null
    for (const [key, v] of votes) {
      if (!best || v.count > best.count) best = { key, count: v.count }
    }
    if (!best) continue
    const matchedPts = [...votes.values()].reduce((a, v) => a + v.count, 0)
    if (best.count < 3 || best.count / matchedPts < 0.25) continue
    // 用该道路身份下"命中点数最多的那条 way"的 tags 做等级映射
    const wayVotes = new Map<number, number>()
    for (let i = 0; i < maxPts; i++) {
      const [lng, lat] = coords[Math.floor((i * coords.length) / maxPts)]
      const h0 = i > 0 ? coords[Math.floor(((i - 1) * coords.length) / maxPts)] : null
      const h1 = i < maxPts - 1 ? coords[Math.floor(((i + 1) * coords.length) / maxPts)] : null
      const routeHeading = h0 && h1 ? bearingDeg(h0[0], h0[1], h1[0], h1[1]) : null
      const hit = index.findNearest(lng, lat, matchRadiusM, routeHeading)
      if (!hit || osmRoadKey(hit.rec.way.tags) !== best.key) continue
      wayVotes.set(hit.rec.way.id, (wayVotes.get(hit.rec.way.id) || 0) + 1)
    }
    let topWay: OsmWay | null = null
    let topWayN = -1
    for (const w of allWays) {
      const n = wayVotes.get(w.id) || 0
      if (n > topWayN) { topWayN = n; topWay = w }
    }
    if (!topWay) continue
    const level = osmTagsToRoadLevel(topWay.tags)
    s.roadLevel = level
    s.osmHighway = topWay.tags.highway
    s.osmRef = topWay.tags.ref || ''
    s.osmName = topWay.tags.name || ''
    s.roadSource = 'osm'
    matched += 1
  }

  // ③ 统计
  for (const s of segments) {
    if (s.roadSource === 'osm') result.osmCoveredKm += s.distanceKm
    else result.ruleFallbackKm += s.distanceKm
  }
  result.waysMatched = matched
  return result
}
