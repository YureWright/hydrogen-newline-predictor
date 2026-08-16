/** 高德驾车路线规划调用层：一次调用返回候选路线 + 逐段实时路况（tmcs） */
import type { RouteCandidate, RoutePlan } from './types'
import { avgSpeedKmh, extractRoadsFromSteps, highwayRatio, round1, round2, sumTraffic } from './parse'

/** 读取高德 Key（从环境变量，不硬编码） */
export function getAmapKey(): string {
  const k = process.env.AMAP_KEY
  if (!k) throw new Error('缺少环境变量 AMAP_KEY，请参考 .env.example 配置')
  return k
}

interface AmapTmcs {
  status?: string | number
  distance?: string | number
  polyline?: string
}

interface AmapStep {
  instruction?: string
  distance?: string | number
  tolls?: string | number
  toll_road?: string[]
  polyline?: string
  tmcs?: AmapTmcs[]
}

interface AmapPath {
  distance?: string | number
  duration?: string | number
  tolls?: string | number
  toll_distance?: string | number
  steps?: AmapStep[]
}

interface AmapResponse {
  status?: string
  info?: string
  route?: { paths?: AmapPath[] }
}

/**
 * 调用高德 v3 驾车路线规划
 * @param origin 起点 "lng,lat"
 * @param destination 终点 "lng,lat"
 * @param opts.strategy 算路策略（默认 10：速度优先+实时路况；11 避拥堵；2 距离最短）
 */
export async function fetchRoutePlan(
  origin: string,
  destination: string,
  opts: { strategy?: number } = {},
): Promise<RoutePlan> {
  const key = getAmapKey()
  const strategy = opts.strategy ?? 10
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
  const routes: RouteCandidate[] = paths.map((p) => {
    const distanceM = Number(p.distance) || 0
    const durationS = Number(p.duration) || 0
    const tollDistanceM = Number(p.toll_distance) || 0
    const steps = p.steps ?? []
    const tmcsAll: AmapTmcs[] = []
    for (const s of steps) if (s.tmcs?.length) tmcsAll.push(...s.tmcs)
    const traffic = sumTraffic(tmcsAll, distanceM / 1000)
    return {
      distanceKm: round1(distanceM / 1000),
      durationH: round2(durationS / 3600),
      tollsYuan: Number(p.tolls) || 0,
      tollDistanceKm: round1(tollDistanceM / 1000),
      highwayRatio: highwayRatio(tollDistanceM, distanceM),
      avgSpeedKmh: avgSpeedKmh(distanceM, durationS),
      traffic,
      polyline: steps.map((s) => s.polyline ?? '').filter(Boolean).join(';'),
      topRoads: extractRoadsFromSteps(steps),
      stepsCount: steps.length,
    }
  })

  return { from: origin, to: destination, requestTime: new Date().toISOString(), routes }
}
