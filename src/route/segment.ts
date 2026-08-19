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
import { mapTrafficStatus, round1, round2, round4 } from './parse'
import { decodePolyline, gcj02ToWgs84 } from './coords'

/** 道路名中不会出现的字符（方向词/连接词），用于限定匹配范围 */
const ROAD_CHAR = '[^，。途径行驶沿进入走向]{2,16}'

/** 从导航指令提取道路名（高德 step 无 road 字段，需从 instruction 提取）
 * 分层匹配：① G/S 编号+高速/国道/省道 → ② 含"高速" → ③ 含"国道/省道" → ④ 沿 X 兜底
 * 示例："沿G6京藏高速途径前河大桥向东行驶90.7公里" → "G6京藏高速"
 */
export function extractRoadName(instruction: string | undefined): string {
  const ins = instruction ?? ''
  const coded = ins.match(/(?:G|S)\d{1,3}[^，。途径行驶]{0,12}?(?:高速|国道|省道)/)
  if (coded) return coded[0]
  const highway = ins.match(new RegExp(ROAD_CHAR + '高速'))
  if (highway) return highway[0]
  const road = ins.match(new RegExp(ROAD_CHAR + '(?:国道|省道)'))
  if (road) return road[0]
  const fallback = ins.match(/沿([^，。途径行驶]{2,24})/)
  if (fallback) return fallback[1].trim()
  return ''
}

/** 由道路名/指令中的等级关键词判定等级；无匹配返回 null */
function levelByKeyword(s: string): RoadLevel | null {
  if (/高速/.test(s)) return 'highway'
  if (/国道/.test(s)) return 'national'
  if (/省道/.test(s)) return 'provincial'
  if (/环|快速|大街|大道/.test(s)) return 'city'
  return null
}

/** "驶出/离开高速""高速出口"——句中出现"高速"，但本段主体已离开高速 */
const LEAVING_HIGHWAY_RE = /(?:驶出|离开)[^，。]{0,16}?高速|高速[^，。]{0,8}出口/
/** 指令中"进入/沿 + 具名道路"，且该道路名本身不含"高速" */
const ENTER_NAMED_ROAD_RE = /(?:进入|沿)((?:(?!高速)[^，。]){2,16}?(?:路|街|大道|大街|环线|桥))/

/**
 * 道路等级推断（顺序：显式关键词 > 收费里程 > 编号 > 城市特征）
 * @param tollDistanceM 本 step 收费里程（米），>0 说明收费公路（中国多为高速）
 */
export function inferRoadLevel(
  roadName: string,
  instruction: string | undefined,
  tollDistanceM = 0,
): RoadLevel {
  const ins = instruction ?? ''
  // "驶出G6京藏高速，进入北清路"：整段主体是北清路，不能因句中出现"高速"就判高速
  // （否则路口密度按 0、停车密度按 0.02、兜底巡航速度按 80km/h，全部偏离城市道路实际）。
  // 仅在无收费里程时生效，避免误判仍行驶在收费高速上的 step。
  if (tollDistanceM <= 0 && LEAVING_HIGHWAY_RE.test(ins)) {
    const other = ins.match(ENTER_NAMED_ROAD_RE)
    if (other) return levelByKeyword(other[1]) ?? 'city'
  }
  const byKeyword = levelByKeyword(roadName + ' ' + ins)
  // 收费里程的优先级高于"环/快速/大街/大道"这类城市特征词（收费的京津快速仍是高速）
  if (byKeyword && byKeyword !== 'city') return byKeyword
  if (tollDistanceM > 0) return 'highway' // 收费公路（中国高速基本收费）
  if (byKeyword === 'city') return 'city'
  if (/^G\d/.test(roadName)) return 'highway' // 无关键词的 G 编号：多为国家高速
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

/** 变速事件概率默认表（可配置；后续可用红绿灯配时/轨迹数据校准） */
export const MOTION_PROB: Record<string, { stop: number; decel: number }> = {
  toll: { stop: 0.1, decel: 0.9 }, // ETC 默认：基本不停，减速通过
  tollMtc: { stop: 0.95, decel: 0.99 }, // 人工收费车道：几乎必停
  service: { stop: 0.1, decel: 0.9 },
  intersection: { stop: 0.4, decel: 1.0 }, // 红绿灯：停车是概率事件（默认 P=0.4）
  intersectionMinor: { stop: 0.35, decel: 1.0 }, // 一般路口（城市，无信号灯关键词）
  ramp: { stop: 0.05, decel: 0.85 },
  turn: { stop: 0.0, decel: 0.7 },
  uTurn: { stop: 0.3, decel: 1.0 }, // 掉头：接近停车
}

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

/**
 * 生成红绿灯路口事件：段内路口数 = 里程 × 密度，期望停车 = 路口数 × 单路口停车概率
 *
 * 路口数按里程线性折算并保留小数，不做"每段至少 1 个"的取整——否则同一条路被地形切分成
 * N 个子段后，路口总数会随 N 膨胀（实测国道 10km 切成 20 段后期望停车虚高 5 倍），
 * 而切分粒度是纯技术参数，不该改变全程路口总数。期望次数本就允许是小数（见 MotionEvent）。
 */
export function buildIntersectionEvents(
  distanceKm: number,
  roadLevel: RoadLevel,
  traffic: TrafficStatus,
): MotionEvent[] {
  const density = INTERSECTION_DENSITY_PER_KM[roadLevel] ?? 0
  if (density <= 0 || distanceKm <= 0) return []
  const n = distanceKm * density
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
 * L1 行为区检测：由导航指令关键词 + 折线航向角 + 道路等级推断变速行为与变速概率。
 * 优先级：收费站 > 服务区 > 匝道 > 红绿灯路口 > 一般路口(城市) > 转弯(指令/几何) > 城市起停/巡航。
 */
export function detectMotionBehavior(
  instruction: string | undefined,
  roadLevel: RoadLevel,
  coordsWgs84: Array<[number, number]>,
): MotionDetection {
  const s = instruction ?? ''
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
    return { behavior: 'intersection', events: [event('stop', p.stop, '红绿灯路口'), event('decel', p.decel, '路口减速')] }
  }
  // ⑤ 一般路口（城市道路指令含"路口"）
  if (roadLevel === 'city' && MINOR_INTERSECTION_RE.test(s)) {
    const p = MOTION_PROB.intersectionMinor
    return { behavior: 'intersection', events: [event('stop', p.stop, '路口'), event('decel', p.decel, '路口减速')] }
  }
  // ⑥ 转弯（指令）
  if (TURN_RE.test(s)) {
    if (UTURN_RE.test(s)) {
      const p = MOTION_PROB.uTurn
      return { behavior: 'turn', events: [event('stop', p.stop, '掉头'), event('decel', p.decel, '掉头减速')] }
    }
    const p = MOTION_PROB.turn
    return { behavior: 'turn', events: [event('decel', p.decel, '转弯减速')] }
  }
  // ⑦ 转弯（几何：航向角突变，指令无关键词时兜底）
  if (maxHeadingChange(coordsWgs84) >= TURN_HEADING_DEG) {
    const p = MOTION_PROB.turn
    return { behavior: 'turn', events: [event('decel', p.decel, '急弯减速(几何)')] }
  }
  // ⑧ 城市起停 / 巡航
  if (roadLevel === 'city') return { behavior: 'urbanStopStart', events: [] }
  return { behavior: 'cruise', events: [] }
}

/** 段内期望停车次数
 * - 有离散停车事件（收费站/路口等）→ 取事件期望次数之和；
 * - 无离散事件的巡航/城市起停段 → 按停车密度 × 里程折算；
 * - 无离散事件的行为事件段（如"同一事件区"里被合并计数的后续 step）→ 计 0，
 *   事件已在同事件区首个 segment 上计过一次，背景密度不再叠加（避免双重计数）。
 */
export function expectedStopCount(seg: SegmentData): number {
  const stopEvs = (seg.motionEvents ?? []).filter((e) => e.type === 'stop')
  if (stopEvs.length > 0) return round2(stopEvs.reduce((a, e) => a + e.expectedCount, 0))
  if (seg.motionBehavior === 'cruise' || seg.motionBehavior === 'urbanStopStart') {
    return round2((seg.stopDensity ?? 0) * seg.distanceKm)
  }
  return 0
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
    const prev = cum
    cum += haversineMeters(coords[i - 1], coords[i])
    // 取距目标更近的那一侧顶点：只认"第一个超过目标"会让切分点系统性偏后，
    // 尾部事件段固定偏短（顶点间距 250m 时切出 1.25km，本应 1.5km），
    // 也让结果对"目标刚好落在顶点上"的浮点误差敏感
    if (cum >= targetM) return targetM - prev < cum - targetM ? i - 1 : i
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
  if (!isEvent || !isLong || coordsWgs84.length < 3) {
    // 短事件 step 或非事件 step：整段保留；非事件段（巡航/城市起停）补挂红绿灯事件
    const inter = isEventBehavior(behavior) ? [] : buildIntersectionEvents(distanceM / 1000, roadLevel, trafficStatus)
    return [{
      ...base,
      distanceKm: round2(distanceM / 1000),
      motionBehavior: behavior,
      motionEvents: [...motion.events, ...inter],
      coordsWgs84,
      durationH: round4(durH),
    }]
  }
  const zoneM = Math.min((EVENT_ZONE_KM[behavior] ?? 1.5) * 1000, distanceM / 2)
  // 事件区在 step 末尾：切分点按"比例"定位到折线上。高德声明里程与 polyline 几何长度
  // 并不总是一致（折线简化后几何偏短），直接拿 distanceM 去几何折线上找点，尾部事件段
  // 长度会随两者比值漂移——比值 0.93 时尾部只剩 0.84km，比值失真更大时甚至整段拆不出来。
  const totalGeoM = cumDistance(coordsWgs84)
  const idx = splitIndexAt(coordsWgs84, totalGeoM * (1 - zoneM / distanceM))
  if (idx <= 0 || idx >= coordsWgs84.length - 1) {
    return [{
      ...base,
      distanceKm: round2(distanceM / 1000),
      motionBehavior: behavior,
      motionEvents: motion.events,
      coordsWgs84,
      durationH: round4(durH),
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
  const tailDurH = tailKm / tailSpeed
  // 尾部按事件典型速度计时，剩余时长归主体段——保证两段时长之和 = step 实测时长。
  // 原实现给尾部单独按 25~35km/h 算时长却不从主体扣除，整条路线总时长会虚增（实测 +2%~8%）。
  // 主体段均速随之由"剩余里程/剩余时长"反推：整步均速里本就含了慢速通过事件区的那段时间。
  // 极端情况（按事件速度算出的时长已吃掉整步时长）退化为按里程比例分配。
  const tailFits = durH - tailDurH > 0
  const headDurH = tailFits ? durH - tailDurH : durH * headFrac
  const headSpeed = headDurH > 0 ? round1(headKm / headDurH) : avgSpeed
  return [
    {
      ...base,
      distanceKm: round2(headKm),
      avgSpeedKmh: headSpeed,
      motionBehavior: headBehavior,
      motionEvents: headEvents,
      coordsWgs84: headCoords,
      durationH: round4(headDurH),
    },
    {
      ...base,
      distanceKm: round2(tailKm),
      avgSpeedKmh: tailSpeed,
      motionBehavior: behavior,
      motionEvents: motion.events,
      coordsWgs84: tailCoords,
      durationH: round4(tailFits ? tailDurH : durH * (1 - headFrac)),
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
    let motion = detectMotionBehavior(step.instruction, roadLevel, coordsWgs84)
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
      last.durationH = round4(last.durationH + durH)
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
  // 坡度/海拔的加权分母单独统计：无 DEM 数据的段（gradePercent=null）不能算进分母，
  // 否则只要有一部分段缺数据，平均坡度/海拔就会被按 0 稀释（缺一半数据时均值直接腰斩）
  let gradeKm = 0
  let elevKm = 0
  for (const s of segments) {
    roadLevelKm[s.roadLevel] += s.distanceKm
    totalKm += s.distanceKm
    totalH += s.durationH
    speedW += s.distanceKm * s.avgSpeedKmh
    if (s.gradePercent != null) {
      gradeW += s.distanceKm * s.gradePercent
      gradeKm += s.distanceKm
    }
    if (s.elevationM != null) {
      elevW += s.distanceKm * s.elevationM
      elevKm += s.distanceKm
    }
  }
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(roadLevelKm)) out[k] = round2(v)
  return {
    totalKm: round1(totalKm),
    totalDurationH: round2(totalH),
    roadLevelKm: out as Record<RoadLevel, number>,
    avgSpeedKmh: totalKm > 0 ? round1(speedW / totalKm) : 0,
    avgGradePercent: gradeKm > 0 ? round2(gradeW / gradeKm) : null,
    avgElevationM: elevKm > 0 ? Math.round(elevW / elevKm) : null,
    segmentCount: segments.length,
  }
}
