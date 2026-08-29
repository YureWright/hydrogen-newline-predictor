/** 高德驾车路线规划调用层：一次调用返回候选路线 + 逐段实时路况（tmcs）+ 可选分段切片 */
import type {
  AmapRawPath, AmapRawStep, AmapRawTmcs,
  RouteCandidate, RoutePlan, SegmentData,
} from './types'
import { avgSpeedKmh, extractRoadsFromSteps, highwayRatio, round1, round2, sumTraffic } from './parse'
import { buildSegments, truckSpeedKmhRoute } from './segment'

/** 读取高德 Key（从环境变量，不硬编码） */
export function getAmapKey(): string {
  const k = process.env.AMAP_KEY
  if (!k) throw new Error('缺少环境变量 AMAP_KEY，请参考 .env.example 配置')
  return k
}

interface AmapResponse {
  status?: string
  info?: string
  route?: { paths?: AmapRawPath[] }
}

/**
 * 调用高德 v3 驾车路线规划，返回原始 paths（含 steps/tmcs/polyline）
 * @param origin 起点 "lng,lat"
 * @param destination 终点 "lng,lat"
 * @param opts.strategy 算路策略（默认 10：速度优先+实时路况；1 避拥堵；2 距离最短）
 *
 * 说明：路线结果按 (origin|destination|strategy) 缓存 10 分钟——
 * 高德在实时路况下多次调用返回的候选路线**顺序可能变化**，若不缓存，
 * "路线列表展示"与"分段测算"两次调用可能选中不同的物理路线。
 */
interface CachedPlan { time: number; paths: AmapRawPath[] }
const planCache = new Map<string, CachedPlan>()
const PLAN_TTL_MS = 10 * 60 * 1000

export async function fetchRawPaths(
  origin: string,
  destination: string,
  opts: { strategy?: number } = {},
): Promise<AmapRawPath[]> {
  const strategy = opts.strategy ?? 10
  const cacheKey = origin + '|' + destination + '|' + strategy
  const hit = planCache.get(cacheKey)
  if (hit && Date.now() - hit.time < PLAN_TTL_MS) return hit.paths

  const key = getAmapKey()
  const url =
    'https://restapi.amap.com/v3/direction/driving?key=' + encodeURIComponent(key) +
    '&origin=' + encodeURIComponent(origin) +
    '&destination=' + encodeURIComponent(destination) +
    '&strategy=' + strategy +
    '&extensions=all'

  const res = await fetch(url, { signal: AbortSignal.timeout(25000) })
  if (!res.ok) throw new Error('高德请求失败: HTTP ' + res.status)
  const data = (await res.json()) as AmapResponse
  if (data.status !== '1') {
    throw new Error('高德接口错误: ' + (data.info || JSON.stringify(data)))
  }
  const paths = data.route?.paths ?? []
  planCache.set(cacheKey, { time: Date.now(), paths })
  return paths
}

/** 原始 path → 候选路线（路线级指标） */
export function pathToCandidate(path: AmapRawPath): RouteCandidate {
  const distanceM = Number(path.distance) || 0
  const durationS = Number(path.duration) || 0
  const tollDistanceM = Number(path.toll_distance) || 0
  const steps: AmapRawStep[] = path.steps ?? []
  const tmcsAll: AmapRawTmcs[] = []
  for (const s of steps) if (s.tmcs?.length) tmcsAll.push(...s.tmcs)
  const traffic = sumTraffic(tmcsAll, distanceM / 1000)
  const hr = highwayRatio(tollDistanceM, distanceM)
  // 高德 duration 是轿车通行时间：路线级均速按高速占比乘重卡系数，时长同步拉长（与段级 truckSpeedKmh 口径一致）
  const truckAvg = round2(truckSpeedKmhRoute(avgSpeedKmh(distanceM, durationS), hr))
  const truckDurH = truckAvg > 0 ? round2((distanceM / 1000) / truckAvg) : round2(durationS / 3600)
  return {
    distanceKm: round1(distanceM / 1000),
    durationH: truckDurH,
    tollsYuan: Number(path.tolls) || 0,
    tollDistanceKm: round1(tollDistanceM / 1000),
    highwayRatio: hr,
    avgSpeedKmh: truckAvg,
    traffic,
    polyline: steps.map((s) => s.polyline ?? '').filter(Boolean).join(';'),
    topRoads: extractRoadsFromSteps(steps),
    stepsCount: steps.length,
  }
}

/** 候选路线列表（原 fetchRoutePlan 行为） */
export async function fetchRoutePlan(
  origin: string,
  destination: string,
  opts: { strategy?: number } = {},
): Promise<RoutePlan> {
  const paths = await fetchRawPaths(origin, destination, opts)
  return {
    from: origin,
    to: destination,
    requestTime: new Date().toISOString(),
    routes: paths.map(pathToCandidate),
  }
}

/**
 * 一次请求同时拿到：候选路线指标 + 分段切片（SegmentData[]，物理模型输入契约）。
 * @param routeIndex 取第几条候选路线做分段（默认 0）
 */
export async function fetchRouteWithSegments(
  origin: string,
  destination: string,
  routeIndex = 0,
  opts: { strategy?: number } = {},
): Promise<{ candidate: RouteCandidate; segments: SegmentData[] }> {
  const paths = await fetchRawPaths(origin, destination, opts)
  const idx = Math.min(Math.max(routeIndex, 0), Math.max(paths.length - 1, 0))
  const path = paths[idx]
  return { candidate: pathToCandidate(path), segments: buildSegments(path) }
}
