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

/* ============================ 物理仿真模型输入契约（A1） ============================ */

/** 道路等级（影响巡航速度基准、停车密度、滚动阻力微调） */
export type RoadLevel = 'highway' | 'national' | 'provincial' | 'city' | 'other'

/**
 * 路段数据 —— 物理仿真模型的标准输入契约（对标 NREL FASTSim 命名惯例）
 *
 * 设计意图：
 * - 这是"企业 MATLAB 氢耗模型"接入时的字段契约：企业模型接入只需写一个 adapter
 *   做字段映射，无需改模型本体（可插拔架构）。
 * - 命名/单位参考 FASTSim：其 drive cycle 用 cyc_secs / cyc_mph / cyc_grade（坡度%），
 *   本结构采用公制 + 明确单位，字段注释标注对应概念。
 * - 基础字段由 A1 分段切片（buildSegments）生成；坡度/海拔/温度由后续里程碑
 *   （A2 DEM / A3 天气）填充，未填充为 null。
 */
export interface SegmentData {
  /** 段序号（从 0 开始） */
  index: number
  /** 道路名（从导航指令提取，可能为空字符串） */
  roadName: string
  /** 道路等级（高速/国道/省道/城市/其他） */
  roadLevel: RoadLevel
  /** 本段里程 km */
  distanceKm: number
  /** 本段平均速度 km/h（由 step 的 distance/duration 实测折算，含实时路况影响） */
  avgSpeedKmh: number
  /** 平均坡度 %（正=上坡，负=下坡；SRTM DEM 计算，A2 填充，未获取为 null） */
  gradePercent: number | null
  /** 平均海拔 m（用于修正空气密度 ρ，A2 填充，未获取为 null） */
  elevationM: number | null
  /** 实时路况（tmcs 距离加权主导状态） */
  trafficStatus: TrafficStatus
  /** 停车/怠速密度 次/km（由道路等级×路况推断，供工况合成起停） */
  stopDensity: number
  /** 气温 ℃（预留：高德天气 API / 线路区间插值，未获取为 null） */
  temperatureC: number | null
  /** 本段坐标序列（WGS-84，[lng,lat]；已由高德 GCJ-02 逆转换，供 DEM/天气采样） */
  coordsWgs84: Array<[number, number]>
  /** 本段时长 h（step duration 实测；缺失时由 distance/avgSpeed 折算） */
  durationH: number
  /** 累计爬升 m（DEM 派生，A2 填充，仅可视化用，非模型输入） */
  elevationGainM?: number | null
  /** 累计下降 m（DEM 派生，A2 填充，仅可视化用，非模型输入） */
  elevationLossM?: number | null
  /** 剖面采样点（A2 填充，仅可视化用）：段内等距采样，distKm 为段内累计里程、elevM 为海拔 */
  profile?: { distKm: number[]; elevM: number[] }
}

/** 路段序列的路级汇总（供工况合成与成本引擎直接使用） */
export interface SegmentSummary {
  totalKm: number
  totalDurationH: number
  /** 各道路等级里程（km） */
  roadLevelKm: Record<RoadLevel, number>
  /** 里程加权平均速度 km/h */
  avgSpeedKmh: number
  /** 里程加权平均坡度 %（A2 填充后才有意义，否则 null） */
  avgGradePercent: number | null
  /** 里程加权平均海拔 m（A2 填充后才有意义，否则 null） */
  avgElevationM: number | null
  segmentCount: number
}

/* ===================== 高德驾车路线规划原始响应（内部解析用） ===================== */

export interface AmapRawTmcs {
  status?: string | number
  distance?: string | number
  polyline?: string
}

export interface AmapRawStep {
  instruction?: string
  distance?: string | number
  duration?: string | number
  tolls?: string | number
  toll_distance?: string | number
  toll_road?: string[]
  polyline?: string
  tmcs?: AmapRawTmcs[]
}

export interface AmapRawPath {
  distance?: string | number
  duration?: string | number
  tolls?: string | number
  toll_distance?: string | number
  steps?: AmapRawStep[]
}
