/** 路线路况模块类型定义 */

/** 逐段路况状态（标准化） */
export type TrafficStatus = 'smooth' | 'slow' | 'congested' | 'severe' | 'unknown'

/** 路线级路况统计（按里程累加） */
export interface TrafficStats {
  smoothKm: number
  slowKm: number
  congestedKm: number
  severeKm: number
  unknownKm: number
  /** 拥堵里程占比 = (缓行+拥堵+严重拥堵) / 总里程 */
  congestionRatio: number
  totalKm: number
}

/** 一条候选路线 */
export interface RouteCandidate {
  distanceKm: number
  durationH: number
  tollsYuan: number
  tollDistanceKm: number
  /** 高速占比 = 收费里程 / 总里程（中国高速基本都收费，作为代理指标） */
  highwayRatio: number
  avgSpeedKmh: number
  traffic: TrafficStats
  /** 逐段坐标（用于坡度采样与加氢站距离计算） */
  polyline: string
  topRoads: string[]
  stepsCount: number
}

/** 一次路线规划的结果 */
export interface RoutePlan {
  from: string
  to: string
  requestTime: string
  routes: RouteCandidate[]
}

/** 加氢站（来自 data/stations.geojson） */
export interface H2Station {
  id: number
  name: string
  lng: number
  lat: number
  price: number | null
  pressure: string
  guns: number | null
  useType: number
}

/** 路线附近的加氢站 */
export interface NearbyStation {
  name: string
  distanceKm: number
  price: number | null
  pressure: string
  guns: number | null
  lng: number
  lat: number
}
