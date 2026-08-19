/** 纯函数解析层：与网络/IO 解耦，可独立单测 */
import type { TrafficStats, TrafficStatus } from './types'

/** 高德 tmcs status → 标准化状态（注意先匹配"严重拥堵"再匹配"拥堵"） */
export function mapTrafficStatus(raw: string | number | undefined): TrafficStatus {
  const s = String(raw ?? '')
  if (s.includes('严重拥堵')) return 'severe'
  if (s.includes('拥堵')) return 'congested'
  if (s.includes('缓行')) return 'slow'
  if (s.includes('畅通')) return 'smooth'
  return 'unknown'
}

/** 累加逐段路况里程 → 路线级统计 */
export function sumTraffic(
  tmcsList: Array<{ status?: string | number; distance?: string | number }>,
  totalKm: number,
): TrafficStats {
  const acc: Record<TrafficStatus, number> = { smooth: 0, slow: 0, congested: 0, severe: 0, unknown: 0 }
  for (const t of tmcsList) {
    const d = Number(t.distance) || 0
    if (d > 0) acc[mapTrafficStatus(t.status)] += d
  }
  const totalM = Object.values(acc).reduce((a, b) => a + b, 0)
  const total = totalM > 0 ? totalM / 1000 : totalKm
  const blocked = (acc.slow + acc.congested + acc.severe) / 1000
  return {
    smoothKm: round1(acc.smooth / 1000),
    slowKm: round1(acc.slow / 1000),
    congestedKm: round1(acc.congested / 1000),
    severeKm: round1(acc.severe / 1000),
    unknownKm: round1(acc.unknown / 1000),
    congestionRatio: total > 0 ? blocked / total : 0,
    totalKm: round1(total),
  }
}

/** 高速占比（收费里程/总里程，中国高速基本收费） */
export function highwayRatio(tollDistanceM: number, distanceM: number): number {
  if (!distanceM || distanceM <= 0) return 0
  return Math.min(1, Math.max(0, tollDistanceM / distanceM))
}

/** 平均速度 km/h */
export function avgSpeedKmh(distanceM: number, durationS: number): number {
  if (!durationS || durationS <= 0) return 0
  return round1((distanceM / 1000) / (durationS / 3600))
}

/** 道路名中不会出现的字符（方向词/连接词），用于限定匹配范围 */
const ROAD_CHAR = '[^，。、；;途径行驶沿进入走向往]{2,16}'

/** 从导航指令提取道路名（高德 step 无 road 字段，需从 instruction 提取）
 * 分层匹配：① G/S 编号+高速/国道/省道 → ② 含"高速" → ③ 含"国道/省道" → ④ 沿/进入 X 兜底
 * 示例："沿G6京藏高速途径前河大桥向东行驶90.7公里" → "G6京藏高速"
 *      "沿幸福大街向南行驶800米，右转进入建设路" → "幸福大街"（不带"向南"）
 */
export function extractRoadName(instruction: string | undefined): string {
  const ins = instruction ?? ''
  const coded = ins.match(/(?:G|S)\d{1,4}[^，。、；;途径行驶]{0,12}?(?:高速|国道|省道)/)
  if (coded) return coded[0]
  const highway = ins.match(new RegExp(ROAD_CHAR + '高速'))
  if (highway) return highway[0]
  const road = ins.match(new RegExp(ROAD_CHAR + '(?:国道|省道)'))
  if (road) return road[0]
  const fallback = ins.match(new RegExp('(?:沿|进入|驶入)(' + ROAD_CHAR + ')'))
  if (fallback) return fallback[1].trim()
  return ''
}

/** 路线主要道路（按里程排序）：与分段用的是同一套道路名提取，避免两处口径不一致 */
export function extractRoadsFromSteps(
  steps: Array<{ instruction?: string; road?: string; distance?: string | number }>,
  topN = 8,
): string[] {
  const score = new Map<string, number>()
  for (const s of steps) {
    // 指令提取为主（能识别长段主导道路，如 G6京藏高速），road 字段（起始道路）兜底
    const name = extractRoadName(s.instruction) || (s.road || '').trim()
    if (!name) continue
    const d = Number(s.distance) || 0
    score.set(name, (score.get(name) || 0) + d)
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([n]) => n)
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10
}
export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** 经纬度 → 平面米坐标（等距圆柱近似，适合小范围距离计算） */
export function lonLatToMeters(lng: number, lat: number, refLat: number): [number, number] {
  const x = lng * 111320 * Math.cos((refLat * Math.PI) / 180)
  const y = lat * 110540
  return [x, y]
}

/** 点到线段的最短距离（米） */
export function pointToSegmentDist(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - ax, py - ay)
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** 点到折线的最短距离（米），coords 为 [lng, lat][] */
export function pointToPolylineDist(lng: number, lat: number, coords: Array<[number, number]>): number {
  if (coords.length < 2) return Infinity
  const refLat = coords[Math.floor(coords.length / 2)][1]
  const [px, py] = lonLatToMeters(lng, lat, refLat)
  let best = Infinity
  for (let i = 0; i < coords.length - 1; i++) {
    const [ax, ay] = lonLatToMeters(coords[i][0], coords[i][1], refLat)
    const [bx, by] = lonLatToMeters(coords[i + 1][0], coords[i + 1][1], refLat)
    const d = pointToSegmentDist(px, py, ax, ay, bx, by)
    if (d < best) best = d
  }
  return best
}
