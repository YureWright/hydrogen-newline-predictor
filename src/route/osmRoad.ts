/**
 * OSM 真实道路等级：把"规则推断"的道路等级换成 OpenStreetMap 真实路网数据。
 *
 * 背景：规则推断（segment.ts 的 inferRoadLevel）只能靠路名关键词 + 收费里程猜道路等级，
 * 城市小路 / 无名路段常被归为"其他"。OSM 是真实路网：每条路带 highway 标签和 ref 编号。
 * 注意：OSM 的 primary/secondary/tertiary/trunk 是相对重要性，不是中国的行政等级——
 * 城市里大量主干道会被标成 primary，不能直接翻译成"国道"。映射顺序见 osmTagsToRoadLevel。
 *
 * 方案（地图匹配 Lite）：
 *   ① 把整条路线折线按累计里程切成 ~40km 走廊分块，每块用 Overpass `around:300`
 *      折线查询，拉回走廊内的 highway 线要素（带几何）；
 *   ② 把每个路段的 WGS-84 折线点吸附到最近 OSM 路段（点-线段距离 ≤150m 且航向平行：
 *      双向路接受同向和反向，因为 OSM 节点顺序跟行驶方向无关；单向路才卡方向），
 *      逐点投票；
 *   ③ 每段取命中点数最多的 OSM 路，且必须覆盖本段采样点的足够比例——分母是采样点数
 *      不是"已命中点数"，否则 3/101 个点碰到一小截 service 路就会把整段高速改成市区；
 *   ④ 无匹配 / 服务不可用 → 保留规则推断值（roadSource='rule'）。
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
import { applyRoadLevelChange } from './segment'

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
  /** 请求间间隔 ms（默认 800，公共镜像限流） */
  delayMs?: number
  /** 全部 OSM 查询的墙钟预算 ms（默认 300000=5 分钟，超时停止查询并保留已完成走廊） */
  queryBudgetMs?: number
  /** 单次 Overpass 客户端超时 ms（默认 20000；服务端 [timeout] 比它短 5 秒，避免算完了客户端已经放弃） */
  timeoutMs?: number
  /** 取消信号：返回 true 时立即停止并保留已完成结果 */
  shouldCancel?: () => boolean
  /** 进度回调（phase: osm-query / osm-match） */
  onProgress?: (p: { phase: 'osm-query' | 'osm-match'; done: number; total: number }) => void
  /** 是否允许写磁盘缓存（默认 true；测试可关） */
  useCache?: boolean
}

export interface OsmRoadResult {
  segments: SegmentData[]
  /** 匹配成功的路段数（不是 distinct OSM way 条数） */
  waysMatched: number
  /** 同 waysMatched，名字不容易被读成"路条数" */
  segmentsMatched: number
  /** 被 OSM 覆盖的里程 km */
  osmCoveredKm: number
  /** 兜底（规则推断）里程 km */
  ruleFallbackKm: number
  /** 实际发出的 Overpass 请求数（缓存命中不计） */
  queries: number
}

/* ============================ OSM highway → RoadLevel ============================ */

/** 剥掉省份简称和空格：`京G107` / `G 107` → `G107`。编号规则只认这个干净形态。 */
export function normalizeOsmRef(ref: string): string {
  const s = (ref || '').trim().replace(/\s+/g, '')
  const m = s.match(/[GSXY]\d+/i)
  return m ? m[0].toUpperCase() : s
}

/**
 * OSM 标签 → 中国行政/物理道路等级。
 *
 * 不能把 highway=primary 直接翻译成国道：OSM 的 primary/secondary/tertiary/trunk
 * 是相对重要性，中国城市主干道大量被标成这几档。顺序必须是：
 *   物理封闭（motorway）> 名称关键词 > 编号位数 > 城市路名后缀 > 标签兜底。
 * 编号放在 motorway 之后、路名之前：S12 即使没写"高速"也是省级高速；
 * 翠亨路即使被标成 primary 也仍是市区路。
 */
export function osmTagsToRoadLevel(tags: Record<string, string>): RoadLevel {
  const rawRef = tags.ref || ''
  const name = tags.name || ''
  const s = name + ' ' + rawRef
  const ref = normalizeOsmRef(rawRef)
  const hw = tags.highway || ''

  // ① 物理证据：封闭式高速。必须压过 ref 前缀，否则 S12/S50/S71 会被判成省道，
  // 平面路口密度从 0 变成 0.6 个/km（25 倍停车口径）。
  if (hw === 'motorway' || hw === 'motorway_link') return 'highway'

  // ② 名称里的显式关键词
  if (/高速|高速公路/.test(s)) return 'highway'
  if (/国道/.test(s)) return 'national'
  if (/省道/.test(s)) return 'provincial'
  if (/县道|乡道/.test(s)) return 'county'
  if (/快速路|高架/.test(s)) return 'expressway'
  if (/环/.test(s)) return 'expressway'

  // ③ 编号：G 后 3 位 = 国道；G 后 1/2/4 位 = 国家高速；
  //    S 后 1~2 位 = 省级高速（S12 机场高速、S50 五环）；S 后 3 位 = 省道（S233）；
  //    X/Y = 县道/乡道。
  if (/^G\d{3}(?!\d)/.test(ref)) return 'national'
  if (/^G\d/.test(ref)) return 'highway'
  if (/^S\d{1,2}(?!\d)/.test(ref)) return 'highway'
  if (/^S\d/.test(ref)) return 'provincial'
  if (/^[XY]\d/.test(ref)) return 'county'

  // ④ 城市路名后缀：有"路/街/大道"就按市区处理，不要升到国道/省道/县道/快速路。
  // 真实走廊里这类 way 约占路网 23%（翠亨路、创业路、通惠河北路……）。
  if (/大街|大道|路|街/.test(name)) return 'city'

  // ⑤ 标签兜底：只给无名、无编号、也不带城市路名的城际路用
  switch (hw) {
    case 'trunk':
    case 'trunk_link':
      return 'expressway'
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
    default:
      return 'other'
  }
}

/** 只查询这些 highway 值（排除 footway/cycleway 等非机动车道，减返回量） */
const HIGHWAY_FILTER =
  '^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|' +
  'tertiary|tertiary_link|unclassified|residential|living_street|service|road)$'


/** 把 OSM 路聚合成"道路身份"键：ref > name > way.id。
 * OSM 一条高速公路常被切成几十个短 way（每个 way 只有 1~2km），
 * 若按 way.id 投票会碎成一地、没有单一 way 过置信阈值；
 * 按 ref 聚合后，同一条 G107 在省界两侧即使 trunk/primary 标签不同也归为一组。
 * 无 ref 无 name 时绝不能塌成 `residential|residential`——那样全城无名小路会共用一个投票桶。 */
export function osmRoadKey(tags: Record<string, string>, wayId?: number): string {
  const ref = normalizeOsmRef(tags.ref || '')
  const name = (tags.name || '').trim()
  const family = (tags.highway || '').replace(/_link$/, '')
  if (ref) return ref + '|ref'
  if (name) return name + '|' + family
  return 'id:' + (wayId ?? 0) + '|' + family
}

/** 投票置信：分母必须是本段采样点数，不是"已经命中的点数"。
 * 3/101 个点碰到一小截 service 路时，旧口径 `3/3 ≥ 25%` 会以 100% 置信改写整段高速。 */
export const MIN_OSM_VOTES = 3
export const MIN_OSM_VOTE_COVERAGE = 0.3
/** 平均吸附距离超过半径的这个比例 → 视为"旁边的路"而不是"路上的路" */
export const MAX_OSM_SNAP_RATIO = 0.6

export function isConfidentOsmMatch(
  bestCount: number,
  sampledPts: number,
  avgDistM: number,
  matchRadiusM: number,
): boolean {
  if (sampledPts < 2 || bestCount < MIN_OSM_VOTES) return false
  if (bestCount / sampledPts < MIN_OSM_VOTE_COVERAGE) return false
  if (avgDistM > matchRadiusM * MAX_OSM_SNAP_RATIO) return false
  return true
}

/** 航向夹角 0~180°（0=同向，180=反向） */
export function headingAbsDiffDeg(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180)
}

/** 平行夹角 0~90°（0=平行含反向，90=垂直）。双向路用这个：OSM 节点顺序跟行驶方向无关。 */
export function headingParallelDiffDeg(a: number, b: number): number {
  const d = headingAbsDiffDeg(a, b)
  return d > 90 ? 180 - d : d
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
  // 服务端预算必须短于客户端超时：客户端先放弃的话，服务端还会把查询算完，
  // 既拿不到结果又白白占镜像配额。预留 5 秒给网络往返。
  const serverTimeoutS = Math.max(10, Math.floor(timeoutMs / 1000) - 5)
  const q =
    '[out:json][timeout:' + serverTimeoutS + '];way["highway"~"' + HIGHWAY_FILTER + '"]' +
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

/** OSM 路网会更新，缓存不能永不过期。30 天量级：路改了能跟上，又不会每次测算都重打 Overpass。 */
export const OSM_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

function loadCache(cacheDir: string, key: string): OsmWay[] | null {
  try {
    const p = cachePath(cacheDir, key)
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8')) as { savedAt?: string; ways?: OsmWay[] }
    if (!Array.isArray(j.ways)) return null
    const savedAt = j.savedAt ? Date.parse(j.savedAt) : NaN
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > OSM_CACHE_TTL_MS) return null
    return j.ways
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

/** 分块折线 → 稳定缓存 key（sha1）。
 * 必须带上 bufferM / highway 过滤器：只哈希折线的话，把走廊从 300m 调到 1000m
 * 会命中旧的 300m 缓存，调参看起来"毫无效果"。 */
export function chunkCacheKey(
  polyline: Array<[number, number]>,
  bufferM: number,
  highwayFilter = HIGHWAY_FILTER,
): string {
  return createHash('sha1')
    .update(
      polyline.map(([lng, lat]) => lng.toFixed(5) + ',' + lat.toFixed(5)).join(';')
        + '|b' + bufferM
        + '|f' + highwayFilter,
    )
    .digest('hex')
    .slice(0, 20)
}

/** 把整条路线坐标按累计里程切成若干走廊分块（每块一条折线） */
export function chunkRouteCoords(
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
  const last = coords[coords.length - 1]
  const tail = pts[pts.length - 1]
  if (!tail || tail[0] !== last[0] || tail[1] !== last[1]) pts.push(last)
  // 再按累计里程分块
  const chunks: Array<Array<[number, number]>> = []
  let cur: Array<[number, number]> = [pts[0]]
  let curKm = 0
  for (let i = 1; i < pts.length; i++) {
    const d = haversineM(pts[i - 1], pts[i])
    if (curKm + d / 1000 > chunkKm && cur.length > 1) {
      chunks.push(cur)
      cur = [pts[i - 1], pts[i]] // 与上一块重叠一个点，保证走廊连续
      curKm = d / 1000
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
            // 双向路：OSM 节点顺序跟行驶方向无关，大约一半是反向数字化的，
            // 只接受同向会把正确的国道整条排除，旁边 80m 的小区路就会以"OSM 真实数据"胜出。
            // 单向路（oneway=yes）才卡方向。
            const oneway = rec.way.tags.oneway === 'yes' || rec.way.tags.oneway === '1'
            const diff = oneway
              ? headingAbsDiffDeg(routeHeadingDeg, segHeading)
              : headingParallelDiffDeg(routeHeadingDeg, segHeading)
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
export function bearingDeg(ax: number, ay: number, bx: number, by: number): number {
  const phi1 = (ay * Math.PI) / 180
  const phi2 = (by * Math.PI) / 180
  const dLng = ((bx - ax) * Math.PI) / 180
  const y = Math.sin(dLng) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** 采样点航向：中间点用前后点，首尾用单边相邻点。
 * 旧实现首尾 routeHeading=null → 完全不做航向过滤，3 点短段里 2 个点不校验方向。 */
export function sampleRouteHeading(
  coords: Array<[number, number]>,
  i: number,
  maxPts: number,
): number | null {
  if (coords.length < 2 || maxPts < 2) return null
  const idx = (j: number) => Math.min(coords.length - 1, Math.floor((j * coords.length) / maxPts))
  const cur = coords[idx(i)]
  if (i > 0 && i < maxPts - 1) {
    const a = coords[idx(i - 1)]
    const b = coords[idx(i + 1)]
    return bearingDeg(a[0], a[1], b[0], b[1])
  }
  if (i < maxPts - 1) {
    const b = coords[idx(i + 1)]
    return bearingDeg(cur[0], cur[1], b[0], b[1])
  }
  if (i > 0) {
    const a = coords[idx(i - 1)]
    return bearingDeg(a[0], a[1], cur[0], cur[1])
  }
  return null
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
  const result: OsmRoadResult = { segments, waysMatched: 0, segmentsMatched: 0, osmCoveredKm: 0, ruleFallbackKm: 0, queries: 0 }

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
    const key = chunkCacheKey(chunks[ci], bufferM)
    opts.onProgress?.({ phase: 'osm-query', done: ci, total: chunks.length })
    const cached = useCache ? loadCache(cacheDir, key) : null
    let ways: OsmWay[]
    if (cached) {
      ways = cached
      consecutiveFails = 0 // 缓存命中说明这条走廊有数据，不是"服务不可用"
      console.log('[osm] 分块 ' + (ci + 1) + '/' + chunks.length + ' 缓存命中（' + cached.length + ' 条路）')
    } else {
      try {
        ways = await queryOverpassChunk(chunks[ci], bufferM, opts.timeoutMs ?? 20000)
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
  const matched = matchSegmentsAgainstWays(segments, [...merged.values()], {
    matchRadiusM,
    onProgress: opts.onProgress,
    shouldCancel: opts.shouldCancel,
  })

  // ③ 统计
  for (const s of segments) {
    if (s.roadSource === 'osm') result.osmCoveredKm += s.distanceKm
    else result.ruleFallbackKm += s.distanceKm
  }
  result.waysMatched = matched
  result.segmentsMatched = matched
  return result
}

/**
 * 用已经拿到的 OSM ways 给路段投票改等级。抽出来给离线测试用：
 * 不连 Overpass，就能复现"反向数字化的国道被小区路抢走"这类确定场景。
 */
export function matchSegmentsAgainstWays(
  segments: SegmentData[],
  ways: OsmWay[],
  opts: {
    matchRadiusM?: number
    onProgress?: (p: { phase: 'osm-query' | 'osm-match'; done: number; total: number }) => void
    shouldCancel?: () => boolean
  } = {},
): number {
  const matchRadiusM = opts.matchRadiusM ?? 150
  const index = new GridIndex(ways)
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
    const votes = new Map<string, { count: number; dist: number; wayVotes: Map<number, number> }>()
    const maxPts = Math.min(coords.length, 800)
    for (let i = 0; i < maxPts; i++) {
      const [lng, lat] = coords[Math.floor((i * coords.length) / maxPts)]
      const routeHeading = sampleRouteHeading(coords, i, maxPts)
      const hit = index.findNearest(lng, lat, matchRadiusM, routeHeading)
      if (!hit) continue
      const key = osmRoadKey(hit.rec.way.tags, hit.rec.way.id)
      const v = votes.get(key)
      if (v) {
        v.count += 1
        v.dist += hit.d
        v.wayVotes.set(hit.rec.way.id, (v.wayVotes.get(hit.rec.way.id) || 0) + 1)
      } else {
        votes.set(key, { count: 1, dist: hit.d, wayVotes: new Map([[hit.rec.way.id, 1]]) })
      }
    }
    let bestKey: string | null = null
    let bestCount = -1
    for (const [key, v] of votes) {
      if (v.count > bestCount) { bestKey = key; bestCount = v.count }
    }
    if (!bestKey) continue
    const best = votes.get(bestKey)!
    if (!isConfidentOsmMatch(best.count, maxPts, best.dist / best.count, matchRadiusM)) continue
    let topWay: OsmWay | null = null
    let topWayN = 0
    for (const w of ways) {
      const n = best.wayVotes.get(w.id) || 0
      if (n > topWayN) { topWayN = n; topWay = w }
    }
    if (!topWay || topWayN < 1) continue
    const level = osmTagsToRoadLevel(topWay.tags)
    const prevLevel = s.roadLevel
    s.roadLevel = level
    s.osmHighway = topWay.tags.highway
    s.osmRef = topWay.tags.ref || ''
    s.osmName = topWay.tags.name || ''
    s.roadSource = 'osm'
    if (level !== prevLevel) applyRoadLevelChange(s)
    matched += 1
  }
  opts.onProgress?.({ phase: 'osm-match', done: totalSeg, total: totalSeg })
  return matched
}
