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
  RoadLevel, SegmentData, SegmentSummary, TrafficStatus,
} from './types'
import { mapTrafficStatus, round1, round2 } from './parse'
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

/** 停车/怠速密度（次/km）= 道路等级基准 × 路况系数 */
export function inferStopDensity(roadLevel: RoadLevel, traffic: TrafficStatus): number {
  return round2(STOP_DENSITY_BASE[roadLevel] * TRAFFIC_STOP_FACTOR[traffic])
}

/**
 * 把一条高德原始路线（path）切成路段序列（SegmentData[]）。
 * 每个 step 一段；坐标转 WGS-84；坡度/海拔/温度暂为 null（后续里程碑填充）。
 */
export function buildSegments(path: AmapRawPath): SegmentData[] {
  const steps: AmapRawStep[] = path.steps ?? []
  const segments: SegmentData[] = []
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
    const durationH = durationS > 0
      ? round2(durationS / 3600)
      : round2(distanceM / 1000 / (avgSpeed || 1))
    const coordsGcj = decodePolyline(step.polyline ?? '')
    const coordsWgs84 = coordsGcj.map(([lng, lat]) => gcj02ToWgs84(lng, lat))
    segments.push({
      index: i,
      roadName,
      roadLevel,
      distanceKm: round2(distanceM / 1000),
      avgSpeedKmh: avgSpeed,
      gradePercent: null,
      elevationM: null,
      trafficStatus,
      stopDensity: inferStopDensity(roadLevel, trafficStatus),
      temperatureC: null,
      coordsWgs84,
      durationH,
    })
  }
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
