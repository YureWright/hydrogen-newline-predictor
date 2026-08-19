/**
 * A1 分段切片：把高德原始路线（steps + tmcs + polyline）切成"路段序列"（SegmentData[]）。
 *
 * 这是物理仿真模型的输入契约实现：
 * - 每个 step 对应 1 个 SegmentData（step 自带 distance / duration / polyline / tmcs）；
 * - 道路名从导航指令提取（实测高德 step 无 road 字段）；
 * - 道路等级、停车密度由道路名 + 收费里程 + 路况推断；
 * - 坐标统一逆转换到 WGS-84（供后续 DEM / 天气采样）。
 */
import type {
  AmapRawPath, AmapRawStep, AmapRawTmcs,
  MotionBehavior, MotionEvent, RoadLevel, SegmentData, SegmentSummary, TrafficStatus,
} from './types'
import { extractRoadName, mapTrafficStatus, round1, round2 } from './parse'
import { decodePolyline, gcj02ToWgs84 } from './coords'

export { extractRoadName }

/**
 * 道路等级推断（顺序：显式关键词 > 收费里程 > 编号 > 城市特征）
 * @param tollDistanceM 本 step 收费里程（米），>0 说明收费公路（中国多为高速）
 */
export function inferRoadLevel(
  roadName: string,
  instruction: string | undefined,
  tollDistanceM = 0,
): RoadLevel {
  const s = roadName + ' ' + (instruction ?? '')
  if (/高速/.test(s)) return 'highway'
  if (/国道/.test(s)) return 'national'
  if (/省道/.test(s)) return 'provincial'
  if (tollDistanceM > 0) return 'highway' // 收费公路（中国高速基本收费）
  if (/环|快速|大街|大道/.test(s)) return 'city'
  // 编号兜底：国道为 3 位（G101~G399），国家高速为 1/2/4 位（G6、G15、G4501）
  if (/^G\d{3}(?!\d)/.test(roadName)) return 'national'
  if (/^G\d/.test(roadName)) return 'highway'
  if (/^S\d/.test(roadName)) return 'provincial' // S 编号：省道
  return 'other'
}

/** 各道路等级基准巡航速度 km/h（step 无 duration 时的兜底值） */
export const CRUISE_SPEED_BY_LEVEL: Record<RoadLevel, number> = {
  highway: 80,
  national: 55,
  provincial: 50,
  city: 30,
  other: 50,
}

/** tmcs 列表 → 距离加权主导路况（status 缺失/未知占比最高时可能返回 unknown） */
export function dominantTrafficStatus(
  tmcs: AmapRawTmcs[] | undefined,
  fallback: TrafficStatus = 'unknown',
): TrafficStatus {
  if (!tmcs || tmcs.length === 0) return fallback
  const acc = new Map<TrafficStatus, number>()
  for (const t of tmcs) {
    const status = mapTrafficStatus(t.status)
    const d = Number(t.distance) || 0
    acc.set(status, (acc.get(status) || 0) + d)
  }
  let best: TrafficStatus = fallback
  let bestD = -1
  for (const [s, d] of acc) {
    if (d > bestD) {
      best = s
      bestD = d
    }
  }
  return best
}

/** 各道路等级基准停车/怠速密度（次/km）：城区约每 500m 一次停车（需求文档 §5.2） */
export const STOP_DENSITY_BASE: Record<RoadLevel, number> = {
  highway: 0.02, // 高速：极少停车（收费站/服务区）
  national: 0.3, // 国道：信号灯较少
  provincial: 0.5,
  city: 2.0, // 城区
  other: 0.5,
}

/** 路况对停车密度的放大系数（拥堵时启停更频繁） */
export const TRAFFIC_STOP_FACTOR: Record<TrafficStatus, number> = {
  smooth: 1.0,
  slow: 1.5,
  congested: 3.0,
  severe: 5.0,
  unknown: 1.0,
}

/* ============================ L1 行为区标注（变速情况 + 变速概率） ============================ */

/** 变速事件概率默认表（可配置；后续可用红绿灯配时/轨迹数据校准）
 * 路口类事件（红绿灯/一般路口/转弯）的**停车**概率不写死在这里，
 * 统一由 INTERSECTION_STOP_PROB[实时路况] 给出，保证"关键词命中"与"按密度折算"两条路径同口径。 */
export const MOTION_PROB: Record<string, { stop: number; decel: number }> = {
  toll: { stop: 0.1, decel: 0.9 }, // ETC 默认：基本不停，减速通过
  tollMtc: { stop: 0.95, decel: 0.99 }, // 人工收费车道：几乎必停
  service: { stop: 0.1, decel: 0.9 },
  ramp: { stop: 0.05, decel: 0.85 },
  turn: { stop: 0.0, decel: 0.7 },
  uTurn: { stop: 0.3, decel: 1.0 }, // 掉头：接近停车
  intersection: { stop: 0.0, decel: 1.0 },
  intersectionMinor: { stop: 0.0, decel: 1.0 },
}

/** 一般路口（无信号灯，让行通过为主）相对信号灯路口的停车概率折减 */
export const MINOR_INTERSECTION_FACTOR = 0.8

/** 红绿灯路口密度（个/km）：高速无路口；国道/省道/城市按实际路口密度 */
export const INTERSECTION_DENSITY_PER_KM: Record<RoadLevel, number> = {
  highway: 0,
  national: 0.4,
  provincial: 0.6,
  city: 3.0, // 城区干道约每 300m 一个路口
  other: 0.5,
}

/** 单个路口停车概率（随实时路况变化：越堵越容易停） */
export const INTERSECTION_STOP_PROB: Record<TrafficStatus, number> = {
  smooth: 0.35,
  slow: 0.55,
  congested: 0.8,
  severe: 0.95,
  unknown: 0.35,
}

/** 单个平面路口的停车概率；高速无平面路口 → 0 */
export function intersectionStopProb(roadLevel: RoadLevel, traffic: TrafficStatus): number {
  if ((INTERSECTION_DENSITY_PER_KM[roadLevel] ?? 0) <= 0) return 0
  return INTERSECTION_STOP_PROB[traffic] ?? 0.35
}

/**
 * 生成背景红绿灯路口事件：段内路口数 = 里程 × 密度，期望停车 = 路口数 × 单路口停车概率。
 * 路口数按期望值取（不取整、不设下限），因此把一段路切成 N 份后各份期望停车之和与整段一致，
 * 切分方式不会改变全线启停能量。
 * @param excludeCount 已由显式事件代表的路口数（如"转弯""红绿灯"事件段），避免同一路口计两次
 */
export function buildIntersectionEvents(
  distanceKm: number,
  roadLevel: RoadLevel,
  traffic: TrafficStatus,
  excludeCount = 0,
): MotionEvent[] {
  const density = INTERSECTION_DENSITY_PER_KM[roadLevel] ?? 0
  if (density <= 0 || distanceKm <= 0) return []
  const n = distanceKm * density - excludeCount
  if (n <= 0) return []
  const p = INTERSECTION_STOP_PROB[traffic] ?? 0.35
  return [{ type: 'stop', expectedCount: round2(n * p), probability: p, label: '红绿灯路口' }]
}

/** 指令关键词 → 行为（优先级：收费站 > 服务区 > 匝道 > 路口 > 转弯） */
const TOLL_RE = /收费站|ETC|人工收费/
const MTC_RE = /人工|MTC/
const SERVICE_RE = /服务区|停车区/
/** 匝道关键词：只认真正"进入/驶出高速国道快速路"或明确"匝道"；
 * 不含"靠右前方/向右前方"——那往往是高速分叉口"保持主路"的引导语，不是匝道。
 * 真正的匝道指令都会带"进入/驶出/匝道"字样（如"向右前方行驶，进入G6京藏高速"）。 */
const RAMP_RE = /匝道|进入[^，。]{0,10}(高速|国道|快速路)|驶出[^，。]{0,10}(高速|国道|快速路)/
const INTERSECTION_RE = /红绿灯|信号灯/
const MINOR_INTERSECTION_RE = /路口/
const TURN_RE = /左转|右转|掉头|转弯|环岛/
const UTURN_RE = /掉头/

/** 几何转弯判定阈值：polyline 相邻航向角最大变化（度）超过该值视为急转弯 */
export const TURN_HEADING_DEG = 40

/** 两点航向角（度，0~360，正北为 0） */
export function bearingDeg(a: [number, number], b: [number, number]): number {
  const [lng1, lat1] = a
  const [lng2, lat2] = b
  const phi1 = (lat1 * Math.PI) / 180
  const phi2 = (lat2 * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const y = Math.sin(dLng) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** 折线上相邻航向角的最大变化（度，0~180） */
export function maxHeadingChange(coords: Array<[number, number]>): number {
  if (coords.length < 3) return 0
  let max = 0
  for (let i = 1; i < coords.length - 1; i++) {
    const b1 = bearingDeg(coords[i - 1], coords[i])
    const b2 = bearingDeg(coords[i], coords[i + 1])
    let d = Math.abs(b2 - b1)
    if (d > 180) d = 360 - d
    if (d > max) max = d
  }
  return max
}

/** 行为检测结果 */
export interface MotionDetection {
  behavior: MotionBehavior
  events: MotionEvent[]
}

function event(type: MotionEvent['type'], probability: number, label: string): MotionEvent {
  return { type, expectedCount: round2(probability), probability: round2(probability), label }
}

/**
 * L1 行为区检测：由导航指令关键词 + 折线航向角 + 道路等级 + 实时路况推断变速行为与变速概率。
 * 优先级：收费站 > 服务区 > 匝道 > 红绿灯路口 > 一般路口(城市) > 转弯(指令/几何) > 城市起停/巡航。
 */
export function detectMotionBehavior(
  instruction: string | undefined,
  roadLevel: RoadLevel,
  coordsWgs84: Array<[number, number]>,
  traffic: TrafficStatus = 'unknown',
): MotionDetection {
  const s = instruction ?? ''
  const interP = intersectionStopProb(roadLevel, traffic)
  // ① 收费站
  if (TOLL_RE.test(s)) {
    const mtc = MTC_RE.test(s)
    const p = mtc ? MOTION_PROB.tollMtc : MOTION_PROB.toll
    const evs: MotionEvent[] = [event('stop', p.stop, mtc ? '人工收费' : 'ETC收费站')]
    if (p.decel > 0) evs.push(event('decel', p.decel, '过站减速'))
    return { behavior: 'toll', events: evs }
  }
  // ② 服务区
  if (SERVICE_RE.test(s)) {
    const p = MOTION_PROB.service
    const evs: MotionEvent[] = [event('stop', p.stop, '服务区')]
    if (p.decel > 0) evs.push(event('decel', p.decel, '进区减速'))
    return { behavior: 'serviceArea', events: evs }
  }
  // ③ 匝道
  if (RAMP_RE.test(s)) {
    const p = MOTION_PROB.ramp
    const evs: MotionEvent[] = [event('decel', p.decel, '匝道减速')]
    if (p.stop > 0) evs.push(event('stop', p.stop, '匝道停车(排队)'))
    return { behavior: 'ramp', events: evs }
  }
  // ④ 红绿灯路口（明确关键词）
  if (INTERSECTION_RE.test(s)) {
    const p = MOTION_PROB.intersection
    const evs: MotionEvent[] = [event('decel', p.decel, '路口减速')]
    if (interP > 0) evs.unshift(event('stop', interP, '红绿灯路口'))
    return { behavior: 'intersection', events: evs }
  }
  // ⑤ 一般路口（城市道路指令含"路口"）
  if (roadLevel === 'city' && MINOR_INTERSECTION_RE.test(s)) {
    const p = MOTION_PROB.intersectionMinor
    const evs: MotionEvent[] = [event('decel', p.decel, '路口减速')]
    if (interP > 0) evs.unshift(event('stop', interP * MINOR_INTERSECTION_FACTOR, '路口'))
    return { behavior: 'intersection', events: evs }
  }
  // ⑥ 转弯（指令）
  if (TURN_RE.test(s)) {
    if (UTURN_RE.test(s)) {
      const p = MOTION_PROB.uTurn
      return { behavior: 'turn', events: [event('stop', p.stop, '掉头'), event('decel', p.decel, '掉头减速')] }
    }
    const p = MOTION_PROB.turn
    const evs: MotionEvent[] = [event('decel', p.decel, '转弯减速')]
    // 城市/国道/省道上的左右转发生在平面路口，转向车流需让行，停车概率与路口同口径；
    // 高速上的"转弯"只是几何弯道，不产生停车。
    if (interP > 0) evs.push(event('stop', interP, '转弯路口'))
    return { behavior: 'turn', events: evs }
  }
  // ⑦ 转弯（几何：航向角突变，指令无关键词时兜底）
  if (maxHeadingChange(coordsWgs84) >= TURN_HEADING_DEG) {
    const p = MOTION_PROB.turn
    const evs: MotionEvent[] = [event('decel', p.decel, '急弯减速(几何)')]
    if (interP > 0) evs.push(event('stop', interP, '转弯路口'))
    return { behavior: 'turn', events: evs }
  }
  // ⑧ 城市起停 / 巡航
  if (roadLevel === 'city') return { behavior: 'urbanStopStart', events: [] }
  return { behavior: 'cruise', events: [] }
}

/** 段内期望停车次数 —— 物理模型的权威口径（stopDensity 只是它的兜底输入之一）
 * - 有停车事件（收费站/路口/转弯等）→ 事件期望次数之和；背景路口已在建段时按里程折算成事件；
 * - 完全没有停车事件 → 退回 stopDensity × 里程，覆盖高速巡航段的偶发停车。
 * 任何行为类型都不会直接返回 0：段里跑了里程，就应有对应的启停期望。
 */
export function expectedStopCount(seg: SegmentData): number {
  const stopEvs = (seg.motionEvents ?? []).filter((e) => e.type === 'stop')
  if (stopEvs.length > 0) return round2(stopEvs.reduce((a, e) => a + e.expectedCount, 0))
  return round2((seg.stopDensity ?? 0) * seg.distanceKm)
}

/** 停车/怠速密度（次/km）= 道路等级基准 × 路况系数 */
export function inferStopDensity(roadLevel: RoadLevel, traffic: TrafficStatus): number {
  return round2(STOP_DENSITY_BASE[roadLevel] * TRAFFIC_STOP_FACTOR[traffic])
}

/**
 * 把一条高德原始路线（path）切成路段序列（SegmentData[]）。
 * 每个 step 一段；坐标转 WGS-84；坡度/海拔/温度暂为 null（后续里程碑填充）。
 */
/** 两点球面距离（米，局部实现，避免 segment.ts 依赖 Node 侧 dem.ts） */
export function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000
  const dLat = ((b[1] - a[1]) * Math.PI) / 180
  const dLng = ((b[0] - a[0]) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

/** 折线累计里程（米） */
function cumDistance(coords: Array<[number, number]>): number {
  let sum = 0
  for (let i = 1; i < coords.length; i++) sum += haversineMeters(coords[i - 1], coords[i])
  return sum
}

/** 沿折线找累计里程 ≥ targetM 的点索引；找不到返回 -1 */
function splitIndexAt(coords: Array<[number, number]>, targetM: number): number {
  let cum = 0
  for (let i = 1; i < coords.length; i++) {
    cum += haversineMeters(coords[i - 1], coords[i])
    if (cum >= targetM) return i
  }
  return -1
}

/** 长事件 step 拆分阈值：超过该里程且带事件关键词的 step，把尾部事件区单独成段 */
export const EVENT_SPLIT_KM = 3.0
/** 尾部事件区长度（km）：匝道/收费站/转弯/服务区 1.5km，路口 0.5km */
const EVENT_ZONE_KM: Partial<Record<MotionBehavior, number>> = {
  toll: 1.5, ramp: 1.5, turn: 1.5, serviceArea: 1.5, intersection: 0.5,
}

/** 是否为"行为事件段"（收费站/匝道/路口/转弯/服务区）——参与行为建模，不参与地形切分 */
export function isEventBehavior(b: MotionBehavior): boolean {
  return b !== 'cruise' && b !== 'urbanStopStart'
}

/** 该行为的显式事件已经代表了几个平面路口（用于扣减背景路口，避免同一路口计两次） */
export function intersectionsRepresentedBy(b: MotionBehavior): number {
  return b === 'intersection' || b === 'turn' ? 1 : 0
}

/** 事件段典型通过速度（km/h，重卡）：长 step 拆分出的尾部事件段用它，避免继承整步 90+km/h 的高速均速
 * —— 否则"单次停车动能 0.5·m·v²"会按 93km/h 算，而实际过收费站/匝道只有 20~40km/h，能量差约 5 倍。 */
const EVENT_SPEED_KMH: Partial<Record<MotionBehavior, number>> = {
  toll: 25, ramp: 35, turn: 30, serviceArea: 30, intersection: 25,
}

/**
 * 长事件 step → 拆成"主体段 + 尾部事件段"。
 * 高德高速长 step 的指令是"沿X路行驶N千米 + 动作"（如"…行驶63.7千米向右前方行驶进入匝道"），
 * 事件发生在 step 末尾——若不拆，整个 63km 都会被标成匝道/转弯，又密又不均衡。
 * - 主体段：城市道路 → urbanStopStart（带红绿灯事件），其余 → cruise（非高速挂红绿灯事件）；
 * - 尾部事件段：保留检测到的事件（收费站/匝道/转弯），均速用事件典型速度。
 * 返回 1~2 个 SegmentData（事件 step 较短或折线不足时保持整段）。
 */
function splitLongEventStep(args: {
  index: number
  roadName: string
  roadLevel: RoadLevel
  distanceM: number
  durationS: number
  avgSpeed: number
  trafficStatus: TrafficStatus
  coordsWgs84: Array<[number, number]>
  motion: MotionDetection
}): SegmentData[] {
  const { index, roadName, roadLevel, distanceM, durationS, avgSpeed, trafficStatus, coordsWgs84, motion } = args
  const behavior = motion.behavior
  const isEvent = isEventBehavior(behavior)
  const isLong = distanceM / 1000 > EVENT_SPLIT_KM
  const stopDensity = inferStopDensity(roadLevel, trafficStatus)
  const durH = durationS > 0 ? durationS / 3600 : distanceM / 1000 / (avgSpeed || 1)
  const base = {
    index,
    roadName,
    roadLevel,
    avgSpeedKmh: avgSpeed,
    gradePercent: null,
    elevationM: null,
    trafficStatus,
    stopDensity,
    temperatureC: null,
  }
  // 整段保留时：段内除了显式事件，还跑过一段路，沿途背景路口按里程折算补上
  const wholeEvents = () => [
    ...motion.events,
    ...buildIntersectionEvents(distanceM / 1000, roadLevel, trafficStatus, intersectionsRepresentedBy(behavior)),
  ]
  if (!isEvent || !isLong || coordsWgs84.length < 3) {
    return [{
      ...base,
      distanceKm: round2(distanceM / 1000),
      motionBehavior: behavior,
      motionEvents: wholeEvents(),
      coordsWgs84,
      durationH: round2(durH),
    }]
  }
  const zoneM = Math.min((EVENT_ZONE_KM[behavior] ?? 1.5) * 1000, distanceM / 2)
  const idx = splitIndexAt(coordsWgs84, distanceM - zoneM)
  if (idx <= 0 || idx >= coordsWgs84.length - 1) {
    return [{
      ...base,
      distanceKm: round2(distanceM / 1000),
      motionBehavior: behavior,
      motionEvents: wholeEvents(),
      coordsWgs84,
      durationH: round2(durH),
    }]
  }
  const headCoords = coordsWgs84.slice(0, idx + 1)
  const tailCoords = coordsWgs84.slice(idx)
  const headGeo = cumDistance(headCoords)
  const tailGeo = cumDistance(tailCoords)
  const totalGeo = headGeo + tailGeo
  const headFrac = totalGeo > 0 ? Math.min(0.99, headGeo / totalGeo) : 0.5
  const headKm = (distanceM / 1000) * headFrac
  const tailKm = (distanceM / 1000) * (1 - headFrac)
  // 主体段行为：城市 → 城市起停（补红绿灯事件）；其余 → 巡航（非高速补红绿灯事件）
  const headBehavior: MotionBehavior = roadLevel === 'city' ? 'urbanStopStart' : 'cruise'
  const headEvents = buildIntersectionEvents(headKm, roadLevel, trafficStatus)
  const tailSpeed = EVENT_SPEED_KMH[behavior] ?? 30
  return [
    {
      ...base,
      distanceKm: round2(headKm),
      motionBehavior: headBehavior,
      motionEvents: headEvents,
      coordsWgs84: headCoords,
      durationH: round2(durH * headFrac),
    },
    {
      ...base,
      distanceKm: round2(tailKm),
      avgSpeedKmh: tailSpeed,
      motionBehavior: behavior,
      motionEvents: [
        ...motion.events,
        ...buildIntersectionEvents(tailKm, roadLevel, trafficStatus, intersectionsRepresentedBy(behavior)),
      ],
      coordsWgs84: tailCoords,
      durationH: round2(tailKm / tailSpeed),
    },
  ]
}

export function buildSegments(path: AmapRawPath): SegmentData[] {
  const steps: AmapRawStep[] = path.steps ?? []
  const segments: SegmentData[] = []
  /** 上一个 segment 的行为（用于同事件区合并计数） */
  let lastBehavior: MotionBehavior | null = null
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const distanceM = Number(step.distance) || 0
    const durationS = Number(step.duration) || 0
    const roadName = extractRoadName(step.instruction)
    const roadLevel = inferRoadLevel(roadName, step.instruction, Number(step.toll_distance) || 0)
    const trafficStatus = dominantTrafficStatus(step.tmcs)
    const avgSpeed = durationS > 0
      ? round1((distanceM / 1000) / (durationS / 3600))
      : CRUISE_SPEED_BY_LEVEL[roadLevel]
    const coordsGcj = decodePolyline(step.polyline ?? '')
    const coordsWgs84 = coordsGcj.map(([lng, lat]) => gcj02ToWgs84(lng, lat))
    const motion = detectMotionBehavior(step.instruction, roadLevel, coordsWgs84, trafficStatus)
    // 同一事件区合并：连续同类"场站型事件"（收费站/匝道/服务区）属于同一座广场/同一处匝道区——
    // 直接合并进上一个事件段（距离/时长/坐标累加），事件只保留一份，避免出现
    // "收费站但无变速事件"的空壳段，也避免一座广场被重复计数
    const isPlazaRun =
      (motion.behavior === 'toll' || motion.behavior === 'ramp' || motion.behavior === 'serviceArea') &&
      motion.behavior === lastBehavior
    if (isPlazaRun && segments.length > 0) {
      const last = segments[segments.length - 1]
      last.distanceKm = round2(last.distanceKm + distanceM / 1000)
      const durH = durationS > 0 ? durationS / 3600 : distanceM / 1000 / (avgSpeed || 1)
      last.durationH = round2(last.durationH + durH)
      last.coordsWgs84 = last.coordsWgs84.concat(coordsWgs84)
      if (last.durationH > 0) last.avgSpeedKmh = round1(last.distanceKm / last.durationH)
      continue // 不 push 新段；lastBehavior 保持同类事件
    }
    const pieces = splitLongEventStep({
      index: i, roadName, roadLevel, distanceM, durationS, avgSpeed,
      trafficStatus, coordsWgs84, motion,
    })
    for (const piece of pieces) {
      segments.push(piece)
      lastBehavior = piece.motionBehavior
    }
  }
  segments.forEach((s, k) => { s.index = k })
  return segments
}

/** 路段序列 → 路级汇总（供工况合成 / 成本引擎直接使用） */
export function summarizeSegments(segments: SegmentData[]): SegmentSummary {
  const roadLevelKm: Record<RoadLevel, number> = {
    highway: 0, national: 0, provincial: 0, city: 0, other: 0,
  }
  let totalKm = 0
  let totalH = 0
  let speedW = 0
  let gradeW = 0
  let elevW = 0
  let hasGrade = false
  let hasElev = false
  for (const s of segments) {
    roadLevelKm[s.roadLevel] += s.distanceKm
    totalKm += s.distanceKm
    totalH += s.durationH
    speedW += s.distanceKm * s.avgSpeedKmh
    if (s.gradePercent != null) {
      gradeW += s.distanceKm * s.gradePercent
      hasGrade = true
    }
    if (s.elevationM != null) {
      elevW += s.distanceKm * s.elevationM
      hasElev = true
    }
  }
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(roadLevelKm)) out[k] = round2(v)
  return {
    totalKm: round1(totalKm),
    totalDurationH: round2(totalH),
    roadLevelKm: out as Record<RoadLevel, number>,
    avgSpeedKmh: totalKm > 0 ? round1(speedW / totalKm) : 0,
    avgGradePercent: hasGrade && totalKm > 0 ? round2(gradeW / totalKm) : null,
    avgElevationM: hasElev && totalKm > 0 ? Math.round(elevW / totalKm) : null,
    segmentCount: segments.length,
  }
}
