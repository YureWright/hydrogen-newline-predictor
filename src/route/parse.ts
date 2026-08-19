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
  // tmcs 未必覆盖全程（部分 step 无 tmcs）：未覆盖里程计入 unknown，
  // 分母恒为路线总里程，否则拥堵占比会被"只按已覆盖里程"放大，
  // 且 totalKm 会与路线 distanceKm 对不上。
  const coveredM = Object.values(acc).reduce((a, b) => a + b, 0)
  // 取 max 兜住 tmcs 距离之和略超路线里程的脏数据，保证分母不小于各路况分量之和
  const routeM = Math.max(totalKm > 0 ? totalKm * 1000 : 0, coveredM)
  if (routeM > coveredM) acc.unknown += routeM - coveredM
  const total = routeM / 1000
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

/** 从导航指令中提取道路名（示例："沿G6京藏高速行驶20.1公里"） */
export function extractRoadsFromSteps(
  steps: Array<{ instruction?: string; distance?: string | number }>,
  topN = 8,
): string[] {
  const score = new Map<string, number>()
  for (const s of steps) {
    const ins = s.instruction ?? ''
    const m = ins.match(/(?:沿|进入|驶入)([^，。;行驶]{2,24})/)
    if (!m) continue
    const name = m[1].trim()
    if (!name || /^(向|往)/.test(name)) continue
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
/** 保留 4 位小数：时长这类小量级数值用 round2 会严重失真
 * （0.5km@80km/h = 0.00625h → 0.01h，偏高 60%），累加后总时长也跟着偏。 */
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000
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
