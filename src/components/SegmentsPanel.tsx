/** 路段数据分析面板：选路 → 点「开始测算」→ 真实进度条 → 表格/可视化/AI 评估 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RouteCandidate, SegmentData, SegmentSummary } from '../route/types'
import { ROAD_LEVEL_LABEL, expectedStopCount } from '../route/segment'
import { DistributionBarsMemo, LineAreaChartMemo, StackedBarMemo } from './Charts'
import MarkdownLight from './MarkdownLight'
import HydrogenHowItWorks from './HydrogenHowItWorks'

interface DemInfo { z: number; tiles: number; source: string }
interface OsmInfo { queries: number; coveredKm: number; fallbackKm: number }
/** 天气抓取状态：必须上屏，否则"全线天气没抓到"和"这段恰好没数据"在界面上长得一模一样 */
interface WeatherInfo {
  provider: string
  sampled: number
  unmatched: number
  bySource: Record<string, number>
  queries: number
  windySegments: number
}
interface SegmentsResponse {
  ok: boolean
  candidate?: RouteCandidate
  segments?: SegmentData[]
  summary?: SegmentSummary
  dem?: DemInfo
  osm?: OsmInfo
  weather?: WeatherInfo
  msg?: string
}
interface JobStatus { ok: boolean; status?: string; phase?: string; done?: number; total?: number; cached?: number; error?: string; msg?: string }
interface AiResponse { ok: boolean; text?: string; model?: string; msg?: string }

/* 深色主题配色：语义与浅色版一致，但整体提亮提纯，保证在近黑底上的对比度。
   与 styles.css 里的 .lv / .tb 徽章色一一对应，同一个含义在图表和表格里必须同色。 */
const ROAD_LEVEL_COLOR: Record<string, string> = {
  highway: '#3ddc97', national: '#4d8dff', provincial: '#ffb547', expressway: '#3ae3ff', city: '#a473ff', county: '#d9a179', other: '#6a7691',
}
const TERRAIN_LABEL: Record<string, string> = { plain: '平原', hilly: '微丘', heavyHilly: '重丘', mountain: '山岭' }
const TERRAIN_COLOR: Record<string, string> = { plain: '#3ddc97', hilly: '#ffb547', heavyHilly: '#ff8a3d', mountain: '#ff6072' }
const TRAFFIC_LABEL: Record<string, string> = {
  smooth: '畅通', slow: '缓行', congested: '拥堵', severe: '严重拥堵', unknown: '未知',
}
const TRAFFIC_COLOR: Record<string, string> = {
  smooth: '#3ddc97', slow: '#ffb547', congested: '#ff6072', severe: '#a473ff', unknown: '#4a5570',
}

const MOTION_LABEL: Record<string, string> = {
  cruise: '巡航', toll: '收费站', intersection: '路口', ramp: '匝道', turn: '转弯', serviceArea: '服务区', urbanStopStart: '城市起停',
}
const MOTION_COLOR: Record<string, string> = {
  cruise: '#7d8aa8', toll: '#ff6072', intersection: '#ff9d4d', ramp: '#4d8dff', turn: '#a473ff', serviceArea: '#3ddc97', urbanStopStart: '#d98f6a',
}
const EVENT_TYPE_LABEL: Record<string, string> = {
  stop: '停止', start: '启动', decel: '减速', turn: '转弯',
}

const MOTION_MARK: Record<string, { label: string; color: string }> = {
  toll: { label: '费', color: '#ff6072' },
  intersection: { label: '口', color: '#ff9d4d' },
  ramp: { label: '匝', color: '#4d8dff' },
  turn: { label: '弯', color: '#a473ff' },
  serviceArea: { label: '服', color: '#3ddc97' },
  urbanStopStart: { label: '起停', color: '#d98f6a' },
}

type SortKey = 'index' | 'distanceKm' | 'gradePercent' | 'elevationM' | 'avgSpeedKmh'
type HydroSortKey =
  | 'index' | 'roadName' | 'distanceKm' | 'avgSpeedKmh' | 'gradePercent' | 'elevationM' | 'temperatureC'
  | 'h2_per_km_kg' | 'h2_kg' | 'v_p85' | 'e_acc' | 'e_aero' | 'e_grade_up' | 'absa_mean'
  | 'cruise_ratio' | 'stop_ratio' | 'v_std' | 'a_p90'
type Stage = 'idle' | 'running' | 'done' | 'error'

/** 模块级常量：无数据时的稳定空数组引用（见下方 segments 的说明） */
const EMPTY_SEGMENTS: SegmentData[] = []
/** 海珀特全系车型预设（H49 / H18 / H4.5）——官网规格优先；官网未公布参数按同族常规值估算（诚实标注，可手动修正） */
interface VehicleParams {
  id: string
  name: string
  brief: string
  curbKg: number
  gvwKg: number
  crr: number
  cd: number
  frontArea: number
  etaMt: number
  pFcMin: number
  pFcMax: number
  pBatMax: number
  etaFc: number
  pAux0: number
  kT: number
  fcKw?: number
  batKwh?: number
  officialH2?: string
  note?: string
}
const H49_PRESET: VehicleParams = {
  id: 'h49', name: 'H49 · 49t 半挂牵引车（干线物流）',
  brief: '300kW 燃料电池 · 75kWh 电池 · 风阻 0.35 · 满载 49t 高速 7.1kg/100km',
  curbKg: 9700, gvwKg: 49000,
  crr: 0.009, cd: 0.35, frontArea: 7.5, etaMt: 0.9,
  pFcMin: 30, pFcMax: 180, pBatMax: 150, etaFc: 0.5, pAux0: 3, kT: 0.15,
  fcKw: 300, batKwh: 75, officialH2: '7.1（满载高速）',
  note: '官网规格：300kW 燃料电池、75kWh 电池、风阻系数 0.35、整备 <10t（取 9.7t）；电堆 [10%,60%] 高效区与电池 ±2C 限幅沿用设计文档',
}
const H18_PRESET: VehicleParams = {
  id: 'h18', name: 'H18 · 18t 燃料电池厢式运输车（城际）',
  brief: '120kW 燃料电池 · 50kWh 电池 · 整备 <9.8t · 官耗 <5.5kg/100km',
  curbKg: 9800, gvwKg: 18000,
  crr: 0.009, cd: 0.55, frontArea: 8.5, etaMt: 0.9,
  pFcMin: 12, pFcMax: 72, pBatMax: 100, etaFc: 0.5, pAux0: 3, kT: 0.15,
  fcKw: 120, batKwh: 50, officialH2: '<5.5（满载）',
  note: '官网规格：120kW 燃料电池、50kWh 电池、整备 <9.8t、最高车速 89km/h、最大爬坡 32%；Cd/迎风面积官网未公布，按厢式货车常规值估算（外廓 2.54×3.95m，迎风面取 8.5m²），可在下方手动修正',
}
const H45_PRESET: VehicleParams = {
  id: 'h45', name: 'H4.5 · 4.5t 燃料电池冷藏车（冷链配送）',
  brief: '80/90kW 燃料电池 · 14.9kWh 电池 · 整备 3.7t · 官耗 <3.10kg/100km',
  curbKg: 3700, gvwKg: 4500,
  crr: 0.009, cd: 0.55, frontArea: 6.0, etaMt: 0.9,
  pFcMin: 9, pFcMax: 54, pBatMax: 30, etaFc: 0.5, pAux0: 2.5, kT: 0.15,
  fcKw: 90, batKwh: 14.9, officialH2: '<3.10（满载）',
  note: '官网规格：80/90kW 燃料电池、14.9kWh 电池、整备 3.7t、最高车速 90km/h、最大爬坡 23%；Cd/迎风面积官网未公布，按冷藏厢式车常规值估算，可在下方手动修正',
}
const VEHICLE_PRESETS: VehicleParams[] = [H49_PRESET, H18_PRESET, H45_PRESET]

/** 车型高级参数输入框（通用小部件：label + number + 单位，悬停有解释） */
function VehicleField({ label, unit, value, min, max, step, tip, onChange }: {
  label: string; unit: string; value: number; min?: number; max?: number; step?: number; tip: string
  onChange: (v: number) => void
}) {
  return (
    <label className="vehicle-field" title={tip}>
      <span>{label}</span>
      <input type="number" min={min} max={max} step={step} value={Number.isFinite(value) ? value : 0}
             onChange={(e) => onChange(Number(e.target.value) || 0)} />
      <em>{unit}</em>
    </label>
  )
}

/** 段行进航向角（0~360，北=0 顺时针）：取折线首尾两点的大圆方位角，供物理模型算逆风分量。
 *  坐标为 WGS-84 [lng,lat]；点数不足返回 null（物理模型据此不计风向）。 */
function segHeadingDeg(coords?: Array<[number, number]>): number | null {
  if (!coords || coords.length < 2) return null
  const [lng1, lat1] = coords[0]
  const [lng2, lat2] = coords[coords.length - 1]
  const rad = Math.PI / 180
  const p1 = lat1 * rad, p2 = lat2 * rad, dl = (lng2 - lng1) * rad
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return (Math.atan2(y, x) / rad + 360) % 360
}

const PHASE_TEXT: Record<string, string> = {
  route: '获取路线分段…',
  dem: '下载高程瓦片…',
  'osm-query': '查询 OSM 真实路网…',
  'osm-match': 'OSM 道路匹配…',
  weather: '抓取沿线天气（按出发时间匹配）…',
  compute: '计算坡度与海拔…',
}
/** 面向用户的步骤名（两段 OSM 合并为"路网"一步） */
const PHASE_STEP_LABELS = ['路线', '高程', '路网', '天气', '汇总']
/** phase → 步骤下标（osm-query 与 osm-match 都归到"路网"这一步） */
const PHASE_TO_STEP: Record<string, number> = {
  route: 0, dem: 1, 'osm-query': 2, 'osm-match': 2, weather: 3, compute: 4,
}

type ResultTab = 'overview' | 'table' | 'hydrogen' | 'ai'
const TAB_LABELS: { key: ResultTab; label: string; icon: string }[] = [
  { key: 'overview', label: '数据概览', icon: '📊' },
  { key: 'table', label: '数据表格', icon: '📋' },
  { key: 'hydrogen', label: '氢耗预测', icon: '⚡' },
  { key: 'ai', label: 'AI 评估', icon: '🤖' },
]

export default function SegmentsPanel({ origin, destination, routeIndex, candidate, onHighlight, onEnterAnalysis, isFullPage }: {
  origin: string
  destination: string
  routeIndex: number
  candidate: RouteCandidate
  onHighlight?: (coordsList: Array<Array<[number, number]>>) => void
  onEnterAnalysis?: () => void
  isFullPage?: boolean
}) {
  const [stage, setStage] = useState<Stage>('idle')
  const [resultTab, setResultTab] = useState<ResultTab>('overview')
  // 出发时间（datetime-local 字符串，默认当前本地时间）；传给后端按"位置+时刻"匹配天气
  const [departureTime, setDepartureTime] = useState(() => {
    const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    return d.toISOString().slice(0, 16)
  })
  const [data, setData] = useState<SegmentsResponse | null>(null)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number; cached: number } | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('index')
  const [sortDesc, setSortDesc] = useState(false)
  const [selectedSegs, setSelectedSegs] = useState<Set<number>>(new Set())
  const toggleSeg = useCallback((index: number) => {
    setSelectedSegs((prev) => {
      const s = new Set(prev)
      if (s.has(index)) s.delete(index)
      else s.add(index)
      return s
    })
  }, [])
  const [aiText, setAiText] = useState('')
  // 氢耗预测（机器学习）
  // 氢耗明细表排序（点击表头；与路段表同一套交互）
  const [hydroSortKey, setHydroSortKey] = useState<HydroSortKey>('index')
  const [hydroSortDesc, setHydroSortDesc] = useState(false)
  // 模型选择：机器学习 / 物理模型 / 双引擎对比
  const [hydroModel, setHydroModel] = useState<'ml' | 'physics' | 'both'>('ml')
  // 物理模型中间变量表排序
  const [phSortKey, setPhSortKey] = useState<string>('index')
  const [phSortDesc, setPhSortDesc] = useState(false)
  const phSort = (k: string) => { if (phSortKey === k) setPhSortDesc(!phSortDesc); else { setPhSortKey(k); setPhSortDesc(false) } }
  const phArrow = (k: string) => (phSortKey === k ? (phSortDesc ? ' ↓' : ' ↑') : '')
  // 物理模型中间变量列（中文名 + 悬停说明）
  const phCols = [
    { key: 'v_mps', cn: '车速', tip: 'm/s = v̄/3.6' },
    { key: 'sigma_kmh', cn: '速度波动 σ', tip: 'km/h；段内速度波动，用于 F_aero 的 E[v²]=v̄²+σ² 修正（波动大→风阻大）' },
    { key: 'rho', cn: '空气密度', tip: 'kg/m³（随海拔 H 修正）' },
    { key: 'F_roll', cn: '滚动阻力', tip: 'N = Crr·m·g·cos(θ)（陡坡时略降）' },
    { key: 'F_aero', cn: '空气阻力', tip: 'N = ½ρCdA·(v_eff²+σ²)；逆风为正/顺风为负' },
    { key: 'F_grade', cn: '坡度阻力', tip: 'N = m·g·sinθ（上坡正/下坡负）' },
    { key: 'F_acc', cn: '加速阻力', tip: 'N = δ·m·a（匀速巡航段=0，接口预留）' },
    { key: 'F_total', cn: '总驱动力', tip: 'N = 四力之和' },
    { key: 'P_wheel', cn: '轮边功率', tip: 'kW = F·v（负=下坡回收）' },
    { key: 'P_aux', cn: '附件功率', tip: 'kW（随温度 T）' },
    { key: 'P_drive', cn: '驱动电功率', tip: 'kW：驱动 P_wheel/η_mt+P_aux；再生 P_wheel×η_mt+P_aux（含链路损耗）' },
    { key: 'P_fc', cn: '电堆功率', tip: 'kW（高效区削峰）' },
    { key: 'P_bat', cn: '电池功率', tip: 'kW（正=放电，负=充电，±P_bat_max 限幅）' },
    { key: 't_h', cn: '行驶时长', tip: 'h = s/v̄' },
    { key: 'eta_fc', cn: '电堆效率', tip: 'η_fc' },
    { key: 'E_fc', cn: '电堆电能', tip: 'kWh = P_fc·t' },
    { key: 'm_H2', cn: '氢耗', tip: 'kg = E_fc/(η_fc·LHV)' },
    { key: 'windSpeedKmh', cn: '风速 km/h', tip: 'km/h；≥10.8 计入风阻' },
    { key: 'windDirText', cn: '风向', tip: '风向（来向）；缺角度/未达阈值则不计风阻' },
  ]
  const [hydroStage, setHydroStage] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  // 载重输入：固定载重（t）或按里程的重量曲线（线性插值到每段）
  const [massMode, setMassMode] = useState<'fixed' | 'curve'>('fixed')
  const [fixedLoadT, setFixedLoadT] = useState(30)
  const [weightPoints, setWeightPoints] = useState<Array<{ km: number; loadT: number }>>([{ km: 0, loadT: 30 }])
  // 车型选择：海珀特全系预设 + 高级参数可调（整备/阻力/电堆/电池/附件等）
  const [vehicle, setVehicle] = useState<VehicleParams>(H49_PRESET)
  const [showVehicleAdvanced, setShowVehicleAdvanced] = useState(false)
  const loadTAtKm = useCallback((km: number) => {
    // 阶梯语义：载重在整个区间内是定值，只有在「装卸货关键点」处突变。
    // 段中点里程落在 [该点km, 下一点km) 区间 → 用该点的载重。
    if (massMode === 'fixed' || !weightPoints.length) return fixedLoadT
    const pts = [...weightPoints].sort((a, b) => a.km - b.km)
    let load = pts[0].loadT
    for (const p of pts) {
      if (km >= p.km) load = p.loadT
      else break
    }
    return load
  }, [massMode, fixedLoadT, weightPoints])
  // 该车型最大载重 t（GVW − 整备）；切换车型时自动收窄，超限输入会夹到上限
  const maxLoadT = Math.max(0, (vehicle.gvwKg - vehicle.curbKg) / 1000)
  const [hydroResult, setHydroResult] = useState<{
    total_h2_kg?: number; per100km_kg?: number; model?: string;
    ml?: any; physics?: any;
    var_cn?: Record<string, string>; var_order?: string[];
    segments?: Array<{
      index: number; roadName?: string; distanceKm: number; avgSpeedKmh: number; gradePercent: number;
      elevationM: number; temperatureC: number; roadLevel?: string;
      v_std: number; v_p85: number; absa_mean: number; a_p90: number;
      cruise_ratio: number; stop_ratio: number; e_acc: number; e_aero: number; e_grade_up: number;
      h2_per_km_kg: number; h2_kg: number;
    } & Record<string, any>>;
  } | null>(null)
  /** 预测进度步骤 0~3（单次 POST 无法真进度，用步骤动画做视觉反馈） */
  const [hydroStep, setHydroStep] = useState(0)
  const [hydroError, setHydroError] = useState('')
  const [showHowItWorks, setShowHowItWorks] = useState(false)
  const [aiModel, setAiModel] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const jobIdRef = useRef('')
  const hydroTimerRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null } }
  /** 测算轮次：每次 start / 取消 / 卸载都自增。
   * jobId 要等 start 请求返回后才拿得到，在这之前用户点「取消」或切换路线的话，
   * 只靠 jobIdRef 判断会漏掉——它还是空串，取消请求带不上 id，后台任务照跑，
   * 而且轮询守卫恰好成立，结果会在用户已经回到首页后自己弹出来。 */
  const runIdRef = useRef(0)

  const cancelJob = useCallback((jobId: string) => {
    if (!jobId) return
    fetch('/api/segments/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    }).catch(() => {})
  }, [])

  // 卸载/换路线时取消任务
  useEffect(() => {
    return () => {
      clearTimer()
      runIdRef.current += 1
      cancelJob(jobIdRef.current)
      jobIdRef.current = ''
    }
  }, [cancelJob])

  const backToSelect = useCallback(() => {
    clearTimer()
    runIdRef.current += 1
    cancelJob(jobIdRef.current)
    jobIdRef.current = ''
    setStage('idle')
    setData(null)
    setError('')
    setProgress(null)
    setAiText('')
    setAiModel('')
    setAiError('')
  }, [cancelJob])

  const start = useCallback(async () => {
    const runId = ++runIdRef.current
    setStage('running')
    setError('')
    setProgress({ phase: 'route', done: 0, total: 0, cached: 0 })
    try {
      const r = await fetch('/api/segments/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin, destination, index: routeIndex, departureTime }),
      })
      const j = await r.json()
      if (runIdRef.current !== runId) { if (j.ok && j.jobId) cancelJob(j.jobId); return }
      if (!j.ok || !j.jobId) { setError(j.msg || '启动测算失败'); setStage('error'); return }
      jobIdRef.current = j.jobId
      poll(j.jobId)
    } catch (e: any) {
      if (runIdRef.current !== runId) return
      setError('启动测算失败：' + (e.message || e))
      setStage('error')
    }
  }, [origin, destination, routeIndex, departureTime, cancelJob])

  const poll = useCallback((jobId: string) => {
    clearTimer()
    timerRef.current = setTimeout(async () => {
      try {
        const r = await fetch('/api/segments/status?jobId=' + encodeURIComponent(jobId))
        const j = (await r.json()) as JobStatus
        if (jobIdRef.current !== jobId) return
        if (j.status === 'running') {
          setProgress({ phase: j.phase || 'dem', done: j.done || 0, total: j.total || 0, cached: j.cached || 0 })
          poll(jobId)
          return
        }
        if (j.status === 'done') {
          const rr = await fetch('/api/segments/result?jobId=' + encodeURIComponent(jobId))
          const jj = (await rr.json()) as SegmentsResponse
          if (!jj.ok) { setError(jj.msg || '获取结果失败'); setStage('error'); return }
          setData(jj)
          setStage('done')
          return
        }
        setError(j.error || j.msg || '测算失败')
        setStage('error')
      } catch (e: any) {
        setError('测算失败：' + (e.message || e))
        setStage('error')
      }
    }, 800)
  }, [])

  // 无数据时必须复用同一个空数组：`?? []` 每次渲染都会新建引用，被下面的 effect 依赖后
  // 会触发 onHighlight → App.setHighlight → 重渲染 → 又一个新引用的无限循环
  const segments = data?.segments ?? EMPTY_SEGMENTS
  const summary = data?.summary

  // 勾选集合变化 → 通知地图同时高亮多条路段
  useEffect(() => {
    if (!onHighlight) return
    const list = [...selectedSegs]
      .map((i) => segments.find((x) => x.index === i)?.coordsWgs84)
      .filter((c): c is Array<[number, number]> => !!c && c.length >= 2)
    onHighlight(list)
  }, [selectedSegs, segments, onHighlight])

  const sorted = useMemo(() => {
    const arr = [...segments]
    // 无数据（null）一律沉到末尾，不参与数值比较。
    // 用 `?? 0` 会把"没取到高程"钉在 0 的位置：按坡度降序找最陡上坡时，
    // 缺数据的段会排在所有下坡段前面，单元格里却显示"—"；按海拔升序时又会假装是全线最低点。
    arr.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return (av < bv ? -1 : av > bv ? 1 : 0) * (sortDesc ? -1 : 1)
    })
    return arr
  }, [segments, sortKey, sortDesc])

  /** 海拔剖面：采样不到高程的点（elevM=null）直接跳过，避免曲线掉到 0 米造成"假平路" */
  const profile = useMemo(() => {
    let cum = 0
    const distKm: number[] = []
    const elevM: number[] = []
    for (const s of segments) {
      if (s.profile && s.profile.distKm.length) {
        for (let i = 0; i < s.profile.distKm.length; i++) {
          const e = s.profile.elevM[i]
          if (e == null) continue
          distKm.push(Math.round((cum + s.profile.distKm[i]) * 10) / 10)
          elevM.push(e)
        }
      }
      cum += s.distanceKm
    }
    return { distKm, elevM }
  }, [segments])

  // 剖面折线点（memo：避免每次渲染重建数千点数组触发图表重算）
  const profilePoints = useMemo(
    () => profile.distKm.map((x, i) => ({ x, y: profile.elevM[i] })),
    [profile],
  )

  const motionMarkers = useMemo(() => {
    let cum = 0
    const markers: Array<{ x: number; label: string; color: string }> = []
    for (const s of segments) {
      const mk = MOTION_MARK[s.motionBehavior]
      if (mk && s.motionBehavior !== 'cruise') markers.push({ x: Math.round(cum * 10) / 10, label: mk.label, color: mk.color })
      cum += s.distanceKm
    }
    return markers
  }, [segments])

  const totalStops = useMemo(() => segments.reduce((a, s) => a + expectedStopCount(s), 0), [segments])

  // 氢耗明细表排序：null 沉底；字符串列（道路名）用 localeCompare，数值列直接比较
  const hydroSorted = useMemo(() => {
    const arr = hydroResult?.segments ? [...hydroResult.segments] : []
    arr.sort((a, b) => {
      const av: unknown = a[hydroSortKey]
      const bv: unknown = b[hydroSortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      let r: number
      if (typeof av === 'string' && typeof bv === 'string') r = av.localeCompare(bv, 'zh')
      else r = Number(av) < Number(bv) ? -1 : Number(av) > Number(bv) ? 1 : 0
      return r * (hydroSortDesc ? -1 : 1)
    })
    return arr
  }, [hydroResult, hydroSortKey, hydroSortDesc])

  // 导出 CSV（所见即所得：按当前排序导出行；\uFEFF BOM 保证 Excel 打开中文不乱码）
  const exportCsv = useCallback(() => {
    if (!segments.length) return
    const esc = (v: string | number | null | undefined): string => {
      const s = v == null ? '' : String(v)
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }
    const header = ['序号', '道路', '等级', '里程km', '均速km/h', '坡度%', '海拔m', '爬升m', '下降m', '变速情况', '变速概率/期望', '路况', '停车次/km', '时长h', '期望停车次数', '地形', '等级来源', '温度℃', '风速km/h', '湿度%', '降水mm', '天气']
    const rows = sorted.map((s) => [
      s.index, s.roadName ?? '', ROAD_LEVEL_LABEL[s.roadLevel], s.distanceKm, s.avgSpeedKmh,
      s.gradePercent ?? '', s.elevationM ?? '', s.elevationGainM ?? '', s.elevationLossM ?? '',
      MOTION_LABEL[s.motionBehavior],
      s.motionEvents.length ? s.motionEvents.map((e) => `${EVENT_TYPE_LABEL[e.type]}${e.expectedCount}`).join(';') : '',
      TRAFFIC_LABEL[s.trafficStatus], s.stopDensity, s.durationH, expectedStopCount(s),
      s.terrain ? TERRAIN_LABEL[s.terrain] : '', s.roadSource === 'osm' ? (s.osmRef || s.osmHighway || 'OSM') : '规则',
      s.temperatureC ?? '', s.windSpeedKmh ?? '', s.humidityPct ?? '', s.precipMm ?? '', s.weatherText ?? '',
    ].map(esc).join(','))
    const csv = '\uFEFF' + [header.join(','), ...rows].join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `路段数据_${origin}_${destination}_route${routeIndex + 1}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [segments, sorted, origin, destination, routeIndex])

  const speedPts = useMemo(() => {
    let cum = 0
    return segments.map((s) => {
      cum += s.distanceKm
      return { x: Math.round(cum * 10) / 10, y: s.avgSpeedKmh }
    })
  }, [segments])

  const trafficItems = candidate.traffic
  // 由 ROAD_LEVEL_LABEL 生成而不是手写清单：手写会漏档（曾漏掉快速路/县乡道），
  // 图表里程加不满、和「总里程」卡片对不上
  const roadLevelItems = useMemo(() => {
    if (!summary) return []
    return (Object.keys(ROAD_LEVEL_LABEL) as Array<keyof typeof ROAD_LEVEL_LABEL>).map((k) => ({
      label: ROAD_LEVEL_LABEL[k],
      value: summary.roadLevelKm[k] ?? 0,
      color: ROAD_LEVEL_COLOR[k],
    }))
  }, [summary])

  const aiPayload = useMemo(() => ({
    origin,
    destination,
    candidate,
    segments: segments.map(({ coordsWgs84, profile: _p, ...rest }) => rest),
    summary,
  }), [origin, destination, candidate, segments, summary])

  const runHydro = useCallback(async () => {
    setHydroStage('running'); setHydroError(''); setHydroStep(1)
    // 步骤动画：①提取段特征 → ②合成工况 → ③模型预测（请求本身秒级，动画只做视觉反馈）
    const timer = window.setInterval(() => setHydroStep((s) => (s < 3 ? s + 1 : s)), 600)
    hydroTimerRef.current = timer
    try {
      // 精简 payload：只传模型需要的字段（去掉 coordsWgs84/profile 等大字段）；每段按"段中点里程"插值载重
      let cumKm = 0
      const slim = (data?.segments ?? []).map((s) => {
        const midKm = cumKm + s.distanceKm / 2
        cumKm += s.distanceKm
        const loadT = loadTAtKm(midKm)
        return {
          index: s.index, roadName: s.roadName, distanceKm: s.distanceKm, avgSpeedKmh: s.avgSpeedKmh,
          gradePercent: s.gradePercent, elevationM: s.elevationM, temperatureC: s.temperatureC,
          windSpeedKmh: s.windSpeedKmh, humidityPct: s.humidityPct, roadLevel: s.roadLevel, durationH: s.durationH,
          // 风向 + 段航向 + 是否达风阻阈值：物理模型据此算逆风/顺风分量（缺则不计风阻）
          windDirDeg: s.windDirDeg ?? null, windDirText: s.windDirText ?? '',
          windAffects: s.windAffects ?? false, headingDeg: segHeadingDeg(s.coordsWgs84),
          massKg: Math.round(vehicle.curbKg + loadT * 1000),
          gainM: s.elevationGainM ?? 0,
          // 车辆/物理参数：物理模型按所选车型逐段计算（ML 只用 massKg，忽略其余车参数）
          crr: vehicle.crr, cd: vehicle.cd, frontArea: vehicle.frontArea, eta_mt: vehicle.etaMt,
          p_fc_min: vehicle.pFcMin, p_fc_max: vehicle.pFcMax, p_bat_max: vehicle.pBatMax,
          eta_fc: vehicle.etaFc, p_aux0: vehicle.pAux0, k_t: vehicle.kT,
        }
      })
      const r = await fetch('/api/predict-hydrogen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segments: slim, departureTime, model: hydroModel }),
      })
      const j = await r.json() as typeof hydroResult & { ok?: boolean; msg?: string }
      if (j.ok) { window.clearInterval(hydroTimerRef.current); hydroTimerRef.current = 0; setHydroResult(j); setHydroStage('done'); setHydroStep(3) }
      else { window.clearInterval(hydroTimerRef.current); hydroTimerRef.current = 0; setHydroError(j.msg || '预测失败'); setHydroStage('error') }
    } catch (e: any) {
      setHydroError('预测失败：' + (e.message || e)); setHydroStage('error'); setHydroStep(0)
      if (hydroTimerRef.current) { window.clearInterval(hydroTimerRef.current); hydroTimerRef.current = 0 }
    }
  }, [data, departureTime, hydroModel, loadTAtKm, vehicle])

  // 活跃结果（both 模式用物理模型 segments 画折线）
  const activeHydro = useMemo<typeof hydroResult>(() => {
    if (!hydroResult) return null
    if (hydroResult.model === 'both') return hydroResult.physics ?? null
    return hydroResult
  }, [hydroResult])
  // 物理模型 segments（both 或 physics）
  const phSegs = useMemo(() => {
    if (hydroResult?.model === 'both') return hydroResult.physics?.segments ?? []
    if (hydroResult?.model === 'physics') return hydroResult.segments ?? []
    return []
  }, [hydroResult])
  // 物理表排序（null 沉底）
  const phSorted = useMemo(() => {
    const arr = [...phSegs]
    arr.sort((a: any, b: any) => {
      const av = a[phSortKey], bv = b[phSortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return (av < bv ? -1 : av > bv ? 1 : 0) * (phSortDesc ? -1 : 1)
    })
    return arr
  }, [phSegs, phSortKey, phSortDesc])
  // ML segments (both mode)
  const mlSegs = useMemo(() => {
    if (hydroResult?.model === 'both') return hydroResult.ml?.segments ?? []
    return []
  }, [hydroResult])
  const mlSorted = useMemo(() => {
    const arr = [...mlSegs]
    arr.sort((a: any, b: any) => {
      const av = a[hydroSortKey], bv = b[hydroSortKey]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return (av < bv ? -1 : av > bv ? 1 : 0) * (hydroSortDesc ? -1 : 1)
    })
    return arr
  }, [mlSegs, hydroSortKey, hydroSortDesc])
  // 氢耗折线：x=累计里程，y=每公里氢耗（kg/100km）；高耗段打标记
  // 依赖 activeHydro（既覆盖单模型也覆盖 both.physics）；写 hydroResult 会漏切换
  const hydroPts = useMemo(() => {
    const segs = activeHydro?.segments ?? []
    let cum = 0
    return segs.map((s) => { cum += s.distanceKm; return { x: Math.round(cum * 10) / 10, y: Math.round(s.h2_per_km_kg * 100 * 100) / 100 } })
  }, [activeHydro])
  const hydroMarkers = useMemo(() => {
    const segs = activeHydro?.segments ?? []
    const thr = Math.max(8, (segs.reduce((a, s) => a + s.h2_per_km_kg, 0) / Math.max(segs.length, 1)) * 100 * 1.5)
    let cum = 0
    const markers: Array<{ x: number; label: string; color: string }> = []
    for (const s of segs) {
      cum += s.distanceKm
      if (s.h2_per_km_kg * 100 > thr) markers.push({ x: Math.round(cum * 10) / 10, label: (s.h2_per_km_kg * 100).toFixed(0) + 'kg', color: '#ff6072' })
    }
    return markers
  }, [activeHydro])
  // 电堆功率曲线：x=累计里程，y=P_fc（kW）
  const fcPts = useMemo(() => {
    const segs = activeHydro?.segments ?? []
    let cum = 0
    return segs.map((s) => { cum += s.distanceKm; return { x: Math.round(cum * 10) / 10, y: Math.round((s.P_fc ?? 0) * 10) / 10 } })
  }, [activeHydro])
  // ML 每公里氢耗曲线（双引擎对比用）
  const mlPts = useMemo(() => {
    let cum = 0
    return mlSegs.map((s: any) => { cum += s.distanceKm; return { x: Math.round(cum * 10) / 10, y: Math.round(s.h2_per_km_kg * 100 * 100) / 100 } })
  }, [mlSegs])
  // 双引擎对比：ML（青） + 物理（绿）两条曲线一张图
  const hydroSeries = useMemo(() => {
    if (hydroResult?.model !== 'both') return null
    return [
      { points: mlPts, color: '#3ae3ff', label: 'ML 实车数据' },
      { points: hydroPts, color: '#3ddc97', label: '物理模型' },
    ]
  }, [hydroResult, mlPts, hydroPts])

  // 物理模型中间变量 CSV 导出
  const exportPhysicsCsv = () => {
    if (!phSorted.length) return
    const head = ['#', '道路', ...phCols.map((c) => c.cn)]
    const rows = phSorted.map((s: any) => [s.index, s.roadName || '', ...phCols.map((c) => s[c.key])])
    const csv = '\uFEFF' + [head, ...rows].map((r) => r.join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    a.download = '物理模型_氢耗中间变量.csv'
    a.click(); URL.revokeObjectURL(a.href)
  }

  // 氢耗明细导出 CSV（普通字段 + 深度工况字段）
  const exportHydroCsv = useCallback(() => {
    // both 模式导出 ML 结果；单模式导出当前结果
    const segs = hydroResult?.model === 'both' ? hydroResult.ml?.segments ?? [] : hydroResult?.segments ?? []
    if (!segs.length) return
    const esc = (v: any): string => {
      const s = v == null ? '' : String(v)
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }
    const header = ['序号', '道路', '等级', '里程km', '均速km/h', '坡度%', '海拔m', '温度℃', '风速km/h', '风向',
      '氢耗kg/km', '氢耗kg', '巡航速度v_p85(km/h)', '加速能量e_acc(相对)', '空阻能量e_aero(相对)', '上坡能量e_grade_up(相对)',
      '加速度均值absa(m/s²)', '巡航占比cruise(0~1)', '停车占比stop(0~1)', '速度波动v_std(km/h)', '强加速a_p90(m/s²)']
    const rows = segs.map((s: any) => [
      s.index, s.roadName ?? '', s.roadLevel ?? '', s.distanceKm, s.avgSpeedKmh, s.gradePercent, s.elevationM, s.temperatureC,
      s.windSpeedKmh ?? '', s.windDirText ?? '',
      (s.h2_per_km_kg * 100).toFixed(2), s.h2_kg, s.v_p85, s.e_acc, s.e_aero, s.e_grade_up,
      s.absa_mean, s.cruise_ratio, s.stop_ratio, s.v_std, s.a_p90,
    ].map(esc).join(','))
    const csv = '\uFEFF' + [header.join(','), ...rows].join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = '氢耗预测明细_route' + (routeIndex + 1) + '.csv'
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, [hydroResult, routeIndex])

  const runAi = useCallback(async () => {
    setAiLoading(true)
    setAiError('')
    setAiText('')
    try {
      const r = await fetch('/api/ai/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(aiPayload),
      })
      const j = (await r.json()) as AiResponse
      if (j.ok && j.text) { setAiText(j.text); setAiModel(j.model || '') }
      else setAiError(j.msg || 'AI 评估失败')
    } catch (e: any) {
      setAiError('AI 评估失败：' + (e.message || e))
    } finally {
      setAiLoading(false)
    }
  }, [aiPayload])

  const headerSort = (k: SortKey) => {
    if (sortKey === k) setSortDesc(!sortDesc)
    else { setSortKey(k); setSortDesc(false) }
  }
  const sortArrow = (k: SortKey) => (sortKey === k ? (sortDesc ? ' ↓' : ' ↑') : '')
  const headerSortHydro = (k: HydroSortKey) => {
    if (hydroSortKey === k) setHydroSortDesc(!hydroSortDesc)
    else { setHydroSortKey(k); setHydroSortDesc(false) }
  }
  const sortArrowHydro = (k: HydroSortKey) => (hydroSortKey === k ? (hydroSortDesc ? ' ↓' : ' ↑') : '')

  /* ---------- 未测算：开始按钮 ---------- */
  if (stage === 'idle') {
    // 单实例架构：点击「开始测算」同时启动测算并切换到分析页
    // 因为是同一个组件实例，start() 设置的 running 状态会无缝延续到分析页
    const handleStartClick = () => {
      start()
      onEnterAnalysis?.()
    }
    return (
      <div className="segments-panel idle-panel">
        <div className="truck-watermark" aria-hidden="true" />
        <div className="idle-head">
          <div>
            <h3>路段数据测算</h3>
            <p className="panel-sub">
              已选 路线 {routeIndex + 1} · {candidate.distanceKm}km · 约 {candidate.durationH}h
              <br />将提取 {candidate.stepsCount} 段路段的坡度/海拔/路况/沿线天气数据（首次约 1~2 分钟，之后走缓存秒级）
            </p>
          </div>
          <div className="depart-box">
            <label className="depart-label">🕐 出发时间
              <input type="datetime-local" value={departureTime} onChange={(e) => setDepartureTime(e.target.value)} />
            </label>
            <div className="depart-hint">按出发时间 + 行驶位置匹配各路段温度/风速/湿度/降水（QWeather·和风天气，未配置 key 时自动用高德兜底）</div>
            <button className="btn-primary" onClick={handleStartClick}>开始测算</button>
          </div>
        </div>
      </div>
    )
  }

  /* ---------- 测算中：进度条 ---------- */
  if (stage === 'running') {
    const total = progress?.total || 0
    const done = progress?.done || 0
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null
    const phaseText = progress?.phase === 'dem' && total > 0
      ? `下载高程瓦片 ${done}/${total}（已缓存 ${progress.cached}）`
      : (PHASE_TEXT[progress?.phase || ''] || '处理中…')
    // 整个测算是多阶段串行的：每换一个阶段进度条都会从 0 重来。没有"第几步"提示时，
    // 用户会把"归零重填"误读成卡死。这里把当前阶段映射到固定步骤序列，明确告诉他还在推进。
    const stepIndex = PHASE_TO_STEP[progress?.phase || ''] ?? 0
    const stepNo = stepIndex + 1
    const truckLeft = pct != null ? `${Math.max(4, Math.min(96, pct))}%` : undefined
    return (
      <div className="segments-panel running-panel">
        <div className="truck-watermark" aria-hidden="true" />
        <h3>正在测算路线 {routeIndex + 1}</h3>
        <div className="progress-box">
          {/* 道路里程碑 */}
          <div className="road-milestones">
            {PHASE_STEP_LABELS.map((label, i) => (
              <span
                key={label}
                className={'road-milestone' + (i < stepIndex ? ' reached' : i === stepIndex ? ' active' : '')}
              >
                <i />{label}
              </span>
            ))}
          </div>
          {/* 道路进度条 */}
          <div className="road-progress">
            <div className="road-track">
              {pct != null && <div className="road-fill" style={{ width: pct + '%' }} />}
              <span
                className={'road-truck' + (pct == null ? ' indeterminate' : '')}
                style={truckLeft ? { left: truckLeft } : undefined}
                role="img"
                aria-label="氢能重卡"
              >🚛</span>
            </div>
          </div>
          <div className="progress-text">
            <span className="step-badge">步骤 {stepNo}/{PHASE_STEP_LABELS.length}</span>
            {phaseText}
          </div>
          <div className="progress-sub">
            {total > 0 ? `${pct}% · 首次下载后本地缓存，同路线重复测算秒级` : '正在准备数据…'}
          </div>
          <button className="btn-cancel" onClick={backToSelect}>取消</button>
        </div>
      </div>
    )
  }

  /* ---------- 失败 ---------- */
  if (stage === 'error') {
    return (
      <div className="segments-panel">
        <h3>路段数据测算</h3>
        <div className="error">{error}</div>
        <div className="ai-actions"><button className="btn-cancel" onClick={backToSelect}>← 返回重新选择</button></div>
      </div>
    )
  }

  /* ---------- 完成：结果面板 ---------- */
  if (!data || !segments.length) return <div className="note">该路线暂无分段数据</div>
  // 没有任何有效高程时显示 "—"：写成 0 会让人以为这条线真的是海拔 0 米的平路，
  // 而同一排卡片里的"平均坡度/平均海拔"走的是 != null 判断、显示 "-"，两种口径并存更容易误读
  const hasElev = profile.elevM.length > 0
  const maxElev = hasElev ? Math.max(...profile.elevM) : null
  const minElev = hasElev ? Math.min(...profile.elevM) : null
  const elevMissingSegs = segments.filter((s) => s.elevationGainM == null).length
  const totalGain = segments.reduce((a, s) => a + (s.elevationGainM ?? 0), 0)
  const totalLoss = segments.reduce((a, s) => a + (s.elevationLossM ?? 0), 0)
  const weather = data.weather
  // 数据完整性：天气/OSM 缺失时预测用默认值/规则推断，明确提示
  // 数据来源完整性（兜底策略透明化）：天气/OSM/DEM 各自覆盖情况
  const weatherOk = !weather || weather.sampled == null || weather.sampled >= segments.length
  const weatherSampled = weather?.sampled ?? 0
  const osmCount = segments.filter((s) => s.roadSource === 'osm').length
  const demCount = segments.filter((s) => s.elevationM != null).length
  const hasFallback = !weatherOk || osmCount === 0 || demCount < segments.length
  const weatherWarn = !weatherOk
    ? '⚠️ 部分路段未匹配到真实天气（' + weatherSampled + '/' + segments.length + ' 段）：预测将用默认温度/湿度/风速（20℃/60%/10km/h），结果仅供参考'
    : (osmCount === 0
      ? '⚠️ OSM 路网不可用，道路等级为规则推断，预测精度会受影响'
      : (demCount < segments.length ? '⚠️ 部分路段缺少 DEM 高程，坡度/海拔使用默认值' : ''))

  return (
    <div className={'segments-panel' + (isFullPage ? ' segments-fullpage' : '')}>
      <div className="result-tabs">
        {TAB_LABELS.map((t) => (
          <button key={t.key} className={'result-tab' + (resultTab === t.key ? ' active' : '')} onClick={() => setResultTab(t.key)}>
            <span className="result-tab-icon">{t.icon}</span>{t.label}
          </button>
        ))}
      </div>
      <div className="panel-title">
        {!isFullPage && <button className="btn-back" onClick={backToSelect}>← 换一条路线</button>}
        {selectedSegs.size > 0 && (
          <button className="btn-back btn-clear-hl" onClick={() => setSelectedSegs(new Set())}>✕ 清除高亮（{selectedSegs.size}）</button>
        )}
        <h3>路段数据分析（{segments.length} 段）</h3>
        <div className={"data-src-bar" + (hasFallback ? " warn" : " ok")}>
          <span className="dsi"><b>天气</b> {weatherSampled}/{segments.length} 段（{weather?.provider === 'qweather' ? 'QWeather' : weather?.provider || '未抓取'}）</span>
          <span className="dsi"><b>道路等级</b> OSM {osmCount}/{segments.length} 段{osmCount < segments.length ? ' · 其余规则推断' : ''}</span>
          <span className="dsi"><b>DEM 高程</b> {demCount}/{segments.length} 段</span>
          {hasFallback && <span className="dsi-warn">⚠️ 部分外部数据不可用，已用默认值/规则推断兜底，结果仅供参考</span>}
        </div>
        <span className="panel-sub">
          {data.dem?.source === 'terrarium'
            ? `高程源：terrarium z${data.dem.z}（${data.dem.tiles} 张瓦片）`
            : `高程源：opentopodata SRTM90m（terrarium 不可用时兜底）`}
          {data.osm && (
            <>
              {' · '}
              <span className={data.osm.coveredKm <= 0 ? 'src-warn' : undefined}>
                {data.osm.coveredKm > 0
                  ? `道路等级：OSM 实测 ${data.osm.coveredKm.toFixed(0)}km / 规则推断 ${data.osm.fallbackKm.toFixed(0)}km`
                  : 'OSM 路网不可用，道路等级全部为规则推断'}
              </span>
            </>
          )}
          {weather && (
            <>
              {' · '}
              <span className={weather.provider === 'none' || weather.unmatched > 0 ? 'src-warn' : undefined}>
                {weather.provider === 'none'
                  ? '未配置天气 Key，沿线温度/风速为空'
                  : `天气源：${weather.provider}（已匹配 ${weather.sampled}/${segments.length} 段${weather.unmatched > 0 ? `，${weather.unmatched} 段未匹配` : ''}）`}
              </span>
            </>
          )}
        </span>
      </div>

      {resultTab === 'overview' && <>
      <div className="stat-cards">
        <div className="stat-card"><b>{summary?.totalKm ?? candidate.distanceKm} km</b><span>总里程</span></div>
        <div className="stat-card"><b>{summary?.avgSpeedKmh ?? '-'}</b><span>全程均速 km/h</span></div>
        <div className="stat-card"><b>{summary?.avgGradePercent != null ? summary.avgGradePercent + '%' : '-'}</b><span>平均坡度</span></div>
        <div className="stat-card"><b>{summary?.avgElevationM != null ? summary.avgElevationM + ' m' : '-'}</b><span>平均海拔</span></div>
        <div className="stat-card" title={elevMissingSegs > 0 ? `${elevMissingSegs} 段无高程数据，未计入` : undefined}>
          <b>{hasElev ? totalGain + ' m' : '—'}{elevMissingSegs > 0 && <sup className="warn-sup">*</sup>}</b><span>累计爬升</span>
        </div>
        <div className="stat-card" title={elevMissingSegs > 0 ? `${elevMissingSegs} 段无高程数据，未计入` : undefined}>
          <b>{hasElev ? totalLoss + ' m' : '—'}{elevMissingSegs > 0 && <sup className="warn-sup">*</sup>}</b><span>累计下降</span>
        </div>
        <div className="stat-card"><b>{maxElev != null ? maxElev + ' m' : '—'}</b><span>最高点</span></div>
        <div className="stat-card"><b>{minElev != null ? minElev + ' m' : '—'}</b><span>最低点</span></div>
        <div className="stat-card"><b>{totalStops.toFixed(1)}</b><span>期望停车/启停次数</span></div>
      </div>

      <div className="charts-grid">
        <div className="chart-card chart-wide">
          <h4>海拔剖面</h4>
          <LineAreaChartMemo points={profilePoints} color="#3ae3ff" yLabel="海拔" unit="m" markers={motionMarkers} />
          {segments.some((s) => s.motionBehavior !== 'cruise') && (
            <div className="motion-legend">
              {(['toll', 'intersection', 'ramp', 'turn', 'serviceArea', 'urbanStopStart'] as const)
                .filter((b) => segments.some((s) => s.motionBehavior === b))
                .map((b) => (
                  <span key={b}><i style={{ background: MOTION_COLOR[b] }} />{MOTION_LABEL[b]}</span>
                ))}
            </div>
          )}
        </div>
        <div className="chart-card">
          <h4>道路等级分布（km）</h4>
          <DistributionBarsMemo items={roadLevelItems} total={summary?.totalKm ?? 1} unit="" />
        </div>
        <div className="chart-card">
          <h4>实时路况分布</h4>
          <StackedBarMemo items={[
            { label: TRAFFIC_LABEL.smooth, value: trafficItems.smoothKm, color: TRAFFIC_COLOR.smooth },
            { label: TRAFFIC_LABEL.slow, value: trafficItems.slowKm, color: TRAFFIC_COLOR.slow },
            { label: TRAFFIC_LABEL.congested, value: trafficItems.congestedKm, color: TRAFFIC_COLOR.congested },
            { label: TRAFFIC_LABEL.severe, value: trafficItems.severeKm, color: TRAFFIC_COLOR.severe },
            { label: TRAFFIC_LABEL.unknown, value: trafficItems.unknownKm, color: TRAFFIC_COLOR.unknown },
          ]} />
        </div>
        <div className="chart-card chart-wide">
          <h4>分段均速（km/h）</h4>
          <LineAreaChartMemo points={speedPts} color="#4d8dff" yLabel="均速" unit="km/h" />
        </div>
      </div>
      </>}

      {resultTab === 'table' &&
      <div className="table-card">
        <div className="table-head">
          <h4>路段数据表</h4>
          <span className="table-tip">☑ 勾选/点击行多选高亮；点击表头排序（# = 起点→终点顺序）</span>
          <button className="btn-export" onClick={exportCsv} disabled={!segments.length} title="按当前排序导出 CSV（含期望停车次数）">⬇ 导出 CSV</button>
        </div>
        <div className="table-scroll">
          <table className="seg-table">
            <thead>
              <tr>
                <th className="chk-th">
                  <input type="checkbox"
                    checked={segments.length > 0 && selectedSegs.size === segments.length}
                    onChange={() => {
                      if (selectedSegs.size === segments.length) setSelectedSegs(new Set())
                      else setSelectedSegs(new Set(segments.map((s) => s.index)))
                    }}
                    title="全选/全不选" />
                </th>
                <th className="sortable" onClick={() => headerSort('index')}>#（路线顺序）{sortArrow('index')}</th>
                <th>道路</th>
                <th>等级</th>
                <th className="sortable" onClick={() => headerSort('distanceKm')}>里程 km{sortArrow('distanceKm')}</th>
                <th className="sortable" onClick={() => headerSort('avgSpeedKmh')}>均速 km/h{sortArrow('avgSpeedKmh')}</th>
                <th className="sortable" onClick={() => headerSort('gradePercent')}>坡度 %{sortArrow('gradePercent')}</th>
                <th className="sortable" onClick={() => headerSort('elevationM')}>海拔 m{sortArrow('elevationM')}</th>
                <th>地形</th>
                <th>温度 ℃</th>
                <th>风速 km/h</th>
                <th>风向</th>
                <th>湿度 %</th>
                <th>降水 mm</th>
                <th>天气</th>
                <th>爬升 m</th>
                <th>下降 m</th>
                <th>变速情况</th>
                <th>变速期望(次)</th>
                <th>路况</th>
                <th>停车次/km</th>
                <th>时长 h</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.index}
                    className={selectedSegs.has(s.index) ? 'row-selected' : ''}
                    onClick={() => toggleSeg(s.index)}>
                  <td className="chk-cell" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selectedSegs.has(s.index)} onChange={() => toggleSeg(s.index)} title="勾选该路段高亮" />
                  </td>
                  <td className="mono">{s.index}</td>
                  <td className="road-name" title={s.roadName + (s.roadSource === 'osm' ? ' [OSM: ' + (s.osmRef || s.osmName || s.osmHighway || '') + ']' : '')}>
                    {s.roadName || '—'}
                    {s.roadSource === 'osm' && <span className="osm-badge" title={'OSM: ' + (s.osmRef || s.osmName || s.osmHighway || '')}>OSM</span>}
                  </td>
                  <td><span className={'lv ' + s.roadLevel}>{ROAD_LEVEL_LABEL[s.roadLevel]}</span></td>
                  <td className="mono">{s.distanceKm}</td>
                  <td className="mono">{s.avgSpeedKmh}</td>
                  <td className={'mono ' + (s.gradePercent != null ? (s.gradePercent > 1 ? 'grade-up' : s.gradePercent < -1 ? 'grade-down' : '') : '')}>
                    {s.gradePercent != null ? s.gradePercent : '—'}
                  </td>
                  <td className="mono">{s.elevationM != null ? s.elevationM : '—'}</td>
                  <td>{s.terrain ? <span className="terrain-chip" style={{ background: TERRAIN_COLOR[s.terrain] }}>{TERRAIN_LABEL[s.terrain]}</span> : '—'}</td>
                  {/* 标红只加在风速列：加在温度列会让大风路段的温度数字变红，被读成"高温预警" */}
                  <td className="mono">{s.temperatureC != null ? s.temperatureC : '—'}</td>
                  <td
                    className={"mono" + (s.windAffects ? " windy" : "")}
                    title={[s.windDirText ? '风向 ' + s.windDirText : '', s.windAffects ? '风速≥阈值，计入风阻' : ''].filter(Boolean).join(' · ')}
                  >{s.windSpeedKmh != null ? s.windSpeedKmh + (s.windAffects ? ' 💨' : '') : '—'}</td>
                  <td className="mono" title={s.windDirDeg != null ? '风向角 ' + s.windDirDeg + '°' : ''}>{s.windDirText ? s.windDirText : '—'}</td>
                  <td className="mono">{s.humidityPct != null ? s.humidityPct : '—'}</td>
                  <td className="mono">{s.precipMm != null ? s.precipMm : '—'}</td>
                  <td className="mono">{s.weatherText || '—'}</td>
                  <td className="mono">{s.elevationGainM != null ? s.elevationGainM : '—'}</td>
                  <td className="mono">{s.elevationLossM != null ? s.elevationLossM : '—'}</td>
                  <td><span className="motion-chip" style={{ background: MOTION_COLOR[s.motionBehavior] }}>{MOTION_LABEL[s.motionBehavior]}</span></td>
                  <td className="mono motion-events" title={s.motionEvents.map((e) => e.label ?? e.type).join(' / ')}>{s.motionEvents.length ? s.motionEvents.map((e) => `${EVENT_TYPE_LABEL[e.type]}${e.expectedCount}`).join(' · ') : '—'}</td>
                  <td><span className="traffic-dot" style={{ background: TRAFFIC_COLOR[s.trafficStatus] }} />{TRAFFIC_LABEL[s.trafficStatus]}</td>
                  <td className="mono">{s.stopDensity}</td>
                  <td className="mono">{s.durationH}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>}

      {resultTab === 'hydrogen' &&
      <div className="h2-card">
        <div className="ai-head">
          <h4>⚡ 氢能消耗预测（{hydroModel === 'physics' ? '物理模型（能量守恒）' : hydroModel === 'both' ? '双引擎对比（机器学习 vs 物理）' : '机器学习（实车数据）'}）</h4>
          <button className="btn-ai" onClick={() => setShowHowItWorks(true)}>📖 技术原理</button>
        </div>
        {hydroStage === 'idle' && (
          <>
            <p className="panel-sub">用两辆 H49 重卡实车数据训练的段级模型：系统分段 → 工况合成（模板拼接）→ 预测每段氢耗，无需实跑即可出结果。</p>
            {weatherWarn && <div className="hydro-warn">{weatherWarn}</div>}
            <div className="mass-input">
              <div className="mass-head">
                <span className="mass-label">🧠 预测模型</span>
                <select value={hydroModel} onChange={(e) => setHydroModel(e.target.value as 'ml' | 'physics' | 'both')}>
                  <option value="ml">机器学习（实车数据）</option>
                  <option value="physics">物理模型（能量守恒公式）</option>
                  <option value="both">双引擎对比</option>
                  <option value="hybrid" disabled>🧪 物理+数据驱动混合（待开发）</option>
                </select>
              </div>
            </div>
            <div className="mass-input vehicle-input">
              <div className="mass-head">
                <span className="mass-label">🚛 车型选择（海珀特全系）</span>
                <select value={vehicle.id} onChange={(e) => {
                  const v = VEHICLE_PRESETS.find((x) => x.id === e.target.value)
                  if (!v) return
                  setVehicle(v)
                  const maxL = Math.max(0, (v.gvwKg - v.curbKg) / 1000)
                  setFixedLoadT((t) => Math.min(t, Math.round(maxL * 10) / 10))
                  setWeightPoints((pts) => pts.map((pt) => ({ ...pt, loadT: Math.min(pt.loadT, Math.round(maxL * 10) / 10) })))
                }}>
                  {VEHICLE_PRESETS.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </div>
              <div className="vehicle-brief">
                <div className="vehicle-brief-line">{vehicle.brief}</div>
                <div className="vehicle-chips">
                  <span>整备 {(vehicle.curbKg / 1000).toFixed(1)} t</span>
                  <span>燃料电池 {vehicle.fcKw} kW</span>
                  <span>电池 {vehicle.batKwh} kWh</span>
                  <span>风阻 Cd {vehicle.cd}</span>
                  <span>官耗 {vehicle.officialH2} kg/100km</span>
                </div>
                {vehicle.id !== 'h49' && (
                  <div className="hydro-warn">⚠️ 机器学习模型用两辆 H49 实车数据训练：切到「{vehicle.name}」后 ML 只能按质量近似外推，建议以「物理模型 / 双引擎对比」为准。</div>
                )}
                {vehicle.note && <div className="vehicle-note">📌 {vehicle.note}</div>}
                <button className="vehicle-toggle" onClick={() => setShowVehicleAdvanced(!showVehicleAdvanced)}>
                  {showVehicleAdvanced ? '▾ 收起高级参数' : '▸ 调整车辆参数（高级）'}
                </button>
                {showVehicleAdvanced && (
                  <div className="vehicle-grid">
                    <VehicleField label="整备质量" unit="t" step={0.1} min={1} value={Math.round(vehicle.curbKg / 100) / 10}
                                  onChange={(v) => setVehicle((prev) => ({ ...prev, curbKg: Math.round(v * 1000) }))}
                                  tip="车辆空载质量（不含货物/氢气），切换车型自动更新" />
                    <VehicleField label="滚动阻力系数 Crr" unit="" step={0.001} min={0.001} value={vehicle.crr}
                                  onChange={(v) => setVehicle((prev) => ({ ...prev, crr: v }))}
                                  tip="轮胎-路面滚动阻力系数，重载卡车典型 0.008~0.012" />
                    <VehicleField label="风阻系数 Cd" unit="" step={0.01} min={0.1} value={vehicle.cd}
                                  onChange={(v) => setVehicle((prev) => ({ ...prev, cd: v }))}
                                  tip="空气阻力系数；牵引车流线型≈0.35，厢式/冷藏车≈0.5~0.6" />
                    <VehicleField label="迎风面积 A" unit="m²" step={0.1} min={1} value={vehicle.frontArea}
                                  onChange={(v) => setVehicle((prev) => ({ ...prev, frontArea: v }))}
                                  tip="正投影面积；厢式车约宽×高×0.85" />
                    <VehicleField label="电机+传动效率 η_mt" unit="" step={0.01} min={0.5} max={0.98} value={vehicle.etaMt}
                                  onChange={(v) => setVehicle((prev) => ({ ...prev, etaMt: v }))}
                                  tip="驱动链效率（电机+减速/传动），典型 0.85~0.93" />
                    <VehicleField label="电堆最低功率" unit="kW" step={1} min={0} value={vehicle.pFcMin}
                                  onChange={(v) => setVehicle((prev) => ({ ...prev, pFcMin: v }))}
                                  tip="电堆最低稳定运行功率（约额定×10%），避免关停-重启损耗" />
                    <VehicleField label="电堆最高功率" unit="kW" step={1} min={0} value={vehicle.pFcMax}
                                  onChange={(v) => setVehicle((prev) => ({ ...prev, pFcMax: v }))}
                                  tip="电堆高效区上限（约额定×60%），超出部分由电池削峰" />
                    <VehicleField label="电池功率限幅" unit="kW" step={1} min={0} value={vehicle.pBatMax}
                                  onChange={(v) => setVehicle((prev) => ({ ...prev, pBatMax: v }))}
                                  tip="电池充/放电最大功率（容量×2C 持续），超限由机械制动耗散" />
                    <VehicleField label="电堆效率 η_fc" unit="" step={0.01} min={0.1} max={0.7} value={vehicle.etaFc}
                                  onChange={(v) => setVehicle((prev) => ({ ...prev, etaFc: v }))}
                                  tip="燃料电池系统效率（含 BOP；H49 官方 >55%，取 0.5 保守）" />
                    <VehicleField label="附件基础功率" unit="kW" step={0.5} min={0} value={vehicle.pAux0}
                                  onChange={(v) => setVehicle((prev) => ({ ...prev, pAux0: v }))}
                                  tip="20℃ 时附件功耗（气泵/转向/低压电子/冷机等）" />
                    <VehicleField label="附件温度系数" unit="kW/℃" step={0.05} min={0} value={vehicle.kT}
                                  onChange={(v) => setVehicle((prev) => ({ ...prev, kT: v }))}
                                  tip="附件功耗随 |T−20℃| 的变化率（空调制冷/PTC 制热等）" />
                  </div>
                )}
              </div>
            </div>
            <div className="mass-input">
              <div className="mass-head">
                <span className="mass-label">⚖️ 载重输入</span>
                <select value={massMode} onChange={(e) => setMassMode(e.target.value as 'fixed' | 'curve')}>
                  <option value="fixed">固定载重</option>
                  <option value="curve">重量曲线（按里程）</option>
                </select>
              </div>
              {massMode === 'fixed' ? (
                <div className="mass-row">
                  <input type="number" min={0} max={Math.max(maxLoadT, 0.1)} step={1} value={fixedLoadT}
                         onChange={(e) => setFixedLoadT(Math.max(0, Math.min(maxLoadT, Number(e.target.value) || 0)))} />
                  <span>吨（总质量 ≈ {((vehicle.curbKg / 1000) + fixedLoadT).toFixed(1)} t）</span>
                </div>
              ) : (
                <div className="mass-curve">
                  {weightPoints.map((p, i) => (
                    <div className="mass-point" key={i}>
                      <input type="number" min={0} placeholder="里程 km" value={p.km}
                             onChange={(e) => { const n = [...weightPoints]; n[i] = { ...n[i], km: Math.max(0, Number(e.target.value) || 0) }; setWeightPoints(n) }} />
                      <span className="mass-unit">km</span>
                      <input type="number" min={0} max={Math.max(maxLoadT, 0.1)} placeholder="载重 t" value={p.loadT}
                             onChange={(e) => { const n = [...weightPoints]; n[i] = { ...n[i], loadT: Math.max(0, Math.min(maxLoadT, Number(e.target.value) || 0)) }; setWeightPoints(n) }} />
                      <span className="mass-unit">t</span>
                      <button className="mass-del" title="删除该关键点"
                              onClick={() => setWeightPoints(weightPoints.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  ))}
                  <button className="mass-add" onClick={() => setWeightPoints([...weightPoints, { km: 0, loadT: fixedLoadT }])}>＋ 添加关键点</button>
                  <p className="mass-tip">「里程 → 载重」表示该里程处的装卸货跳变：路段落在哪个区间就用哪个载重（中间恒定、装卸点突变，如 0km=20t → 200km=10t 表示 200km 处卸货一半）。</p>
                </div>
              )}
            </div>
            <button className="btn-primary" onClick={runHydro}>开始氢耗预测</button>
          </>
        )}
        {hydroStage === 'running' && (
          <div className="hydro-road">
            <div className="road-milestones">
              <span className={'road-milestone' + (hydroStep >= 1 ? ' reached' : '')}>
                <i />提取段特征
              </span>
              <span className={'road-milestone' + (hydroStep >= 2 ? ' reached' : hydroStep >= 1 ? ' active' : '')}>
                <i />合成行驶工况
              </span>
              <span className={'road-milestone' + (hydroStep >= 3 ? ' reached' : hydroStep >= 2 ? ' active' : '')}>
                <i />模型预测
              </span>
            </div>
            <div className="road-progress">
              <div className="road-track">
                <span className="road-truck indeterminate" role="img" aria-label="氢能重卡">🚛</span>
              </div>
            </div>
            <div className="hydro-progress-tip">{hydroModel === 'physics' ? '正在调用物理模型计算四阻力→轮边功率→电堆/电池削峰→氢耗…' : '正在按道路等级×均速从实车片段库拼接 60s 工况…'}</div>
          </div>
        )}
        {hydroError && <div className="error">{hydroError}</div>}
        {hydroStage === 'done' && hydroResult && (
          <div className="hydro-result">
            <div className="hydro-model-tag">预测模型：{hydroResult.model === 'both' ? '双引擎对比（机器学习 vs 物理模型）' : hydroResult.model === 'physics' ? '物理模型（能量守恒公式）' : '机器学习（实车数据）'}</div>

                <div className="hydro-model-switch">
                  <span className="hydro-model-switch-label">切换模型重算：</span>
                  <select value={hydroModel} onChange={(e) => setHydroModel(e.target.value as 'ml' | 'physics' | 'both')}>
                    <option value="ml">机器学习（实车数据）</option>
                    <option value="physics">物理模型（能量守恒公式）</option>
                    <option value="both">双引擎对比</option>
                    <option value="hybrid" disabled>🧪 物理+数据驱动混合（待开发）</option>
                  </select>
                  <button className="btn-export" onClick={runHydro} disabled={hydroModel === hydroResult.model}>↻ 重新测算</button>
                  <span className="hydro-model-switch-hint">{hydroModel === hydroResult.model ? '（当前结果即所选模型）' : '（已切换，点击重新测算）'}</span>
                </div>
            {(hydroResult.model === 'physics' || hydroResult.model === 'both') ? (
              <>
                <div className="hydro-metrics">
                  {hydroResult.model === 'both' && (<>
                    <div className="hydro-metric"><b>{hydroResult.ml?.total_h2_kg?.toFixed(2)}</b><span>ML 总氢耗 kg</span></div>
                    <div className="hydro-metric"><b>{hydroResult.ml?.per100km_kg?.toFixed(2)}</b><span>ML 百公里 kg/100km</span></div>
                  </>)}
                  <div className="hydro-metric"><b>{activeHydro?.total_h2_kg?.toFixed(2)}</b><span>物理 总氢耗 kg</span></div>
                  <div className="hydro-metric"><b>{activeHydro?.per100km_kg?.toFixed(2)}</b><span>物理 百公里 kg/100km</span></div>
                  <div className="hydro-metric"><b>{segments.length}</b><span>路段数</span></div>
                </div>
                <div className="hydro-note">💡 物理模型按能量守恒：总氢耗 = 电堆电能/(电堆效率×氢热值)，含滚动/空气/坡度阻力与附件功耗；已按车型「{vehicle.name}」、载重（{massMode === 'fixed' ? fixedLoadT + ' t' : '重量曲线'}）、海拔、温度参与计算。{hydroResult.model === 'both' ? '与机器学习对比：一致则互相印证，差异大请检查输入。' : '红线标记为高耗路段（超过 8 kg/100km 或均值 1.5 倍）。'}</div>
                {(() => {
                  const missing = phSegs.filter((p: any) => p.grade_missing).length
                  if (missing === 0) return null
                  return (
                    <div className="hydro-warn">⚠️ {missing} 段无坡度数据，物理模型按平路(0%)计算：山区/丘陵路线氢耗可能被系统性低估（表格中带 ⚠ 的路段为坡度缺失段）</div>
                  )
                })()}
                <div className="hydro-src-note"><b>物理模型参数（{vehicle.name}）：</b>Crr={vehicle.crr} · Cd={vehicle.cd} · A={vehicle.frontArea}m² · η_mt={vehicle.etaMt} · P_fc∈[{vehicle.pFcMin},{vehicle.pFcMax}]kW · P_bat≤{vehicle.pBatMax}kW · η_fc={vehicle.etaFc} · LHV=33.3 kWh/kg（详见技术原理 / 设计文档）</div>
                <div className="hydro-chart">
                  <LineAreaChartMemo series={hydroSeries ?? undefined} points={hydroPts} color="#3ddc97" yLabel="每公里氢耗" unit="kg/100km" markers={hydroMarkers} />
                </div>
                <div className="hydro-chart hydro-chart-fc">
                  <LineAreaChartMemo points={fcPts} color="#ffb547" yLabel="电堆功率" unit="kW" />
                </div>
                {hydroResult.model === 'both' && hydroResult.ml?.segments?.length ? (
                  <div className="hydro-table-wrap">
                    <div className="hydro-table-head">
                      <span>🤖 机器学习明细（{hydroResult.ml.segments.length} 段）<span className="table-tip">点击表头排序（# = 起点→终点顺序）</span></span>
                      <button className="btn-export" onClick={exportHydroCsv} disabled={!mlSorted.length}>⬇ 导出 CSV</button>
                    </div>
                    <div className="hydro-table-scroll">
                      <table className="hydro-table">
                        <thead>
                          <tr>
                            <th className="sortable" onClick={() => headerSortHydro('index')}>#（路线顺序）{sortArrowHydro('index')}</th>
                            <th>道路</th>
                            <th>等级</th>
                            <th className="sortable" onClick={() => headerSortHydro('distanceKm')}>里程km{sortArrowHydro('distanceKm')}</th>
                            <th className="sortable" onClick={() => headerSortHydro('avgSpeedKmh')}>均速 km/h{sortArrowHydro('avgSpeedKmh')}</th>
                            <th className="sortable" onClick={() => headerSortHydro('gradePercent')}>坡度%{sortArrowHydro('gradePercent')}</th>
                            <th className="sortable" onClick={() => headerSortHydro('elevationM')}>海拔m{sortArrowHydro('elevationM')}</th>
                            <th className="sortable" onClick={() => headerSortHydro('temperatureC')}>温度℃{sortArrowHydro('temperatureC')}</th>
                            <th>风速 km/h</th><th>风向</th>
                            <th className="sortable" onClick={() => headerSortHydro('h2_per_km_kg')}>氢耗kg/km{sortArrowHydro('h2_per_km_kg')}</th>
                            <th className="sortable" onClick={() => headerSortHydro('h2_kg')}>氢耗kg{sortArrowHydro('h2_kg')}</th>
                            <th className="sortable" title="巡航速度第85分位(km/h)" onClick={() => headerSortHydro('v_p85')}>巡航速度 v_p85 km/h{sortArrowHydro('v_p85')}</th>
                            <th className="sortable" title="加速能量/km：每公里用于加速的轮边能量" onClick={() => headerSortHydro('e_acc')}>加速能量 e_acc(相对){sortArrowHydro('e_acc')}</th>
                            <th className="sortable" title="空气阻力能量/km：每公里撞开空气的轮边能量(∝v³)，高速重卡最大能量项" onClick={() => headerSortHydro('e_aero')}>空阻能量 e_aero(相对){sortArrowHydro('e_aero')}</th>
                            <th className="sortable" title="上坡能量/km：每公里克服重力爬坡的轮边能量（只计上坡，下坡可回收）" onClick={() => headerSortHydro('e_grade_up')}>上坡能量 e_grade_up(相对){sortArrowHydro('e_grade_up')}</th>
                            <th className="sortable" title="平均加速度强度(m/s²)：加减速平均幅度，反映驾驶激进程度" onClick={() => headerSortHydro('absa_mean')}>平均加速度 absa m/s²{sortArrowHydro('absa_mean')}</th>
                            <th className="sortable" title="巡航占比：平稳行驶(|a|<0.15)时间占比，高=电堆高效区多=省氢" onClick={() => headerSortHydro('cruise_ratio')}>巡航占比 cruise 0~1{sortArrowHydro('cruise_ratio')}</th>
                            <th className="sortable" title="停车占比：车速<1km/h 时间占比，高=起步频繁+附件时间摊薄=费氢" onClick={() => headerSortHydro('stop_ratio')}>停车占比 stop 0~1{sortArrowHydro('stop_ratio')}</th>
                            <th className="sortable" title="速度标准差(km/h)：速度波动程度，区分均速巡航与走走停停" onClick={() => headerSortHydro('v_std')}>速度波动 v_std km/h{sortArrowHydro('v_std')}</th>
                            <th className="sortable" title="强加速水平(m/s²)：最猛10%时刻的加速度，捕捉急加速/急刹车" onClick={() => headerSortHydro('a_p90')}>强加速 a_p90 m/s²{sortArrowHydro('a_p90')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {mlSorted.map((m: any) => (
                            <tr key={m.index}>
                              <td className="mono">{m.index}</td>
                              <td className="road-name">{m.roadName || '—'}</td>
                              <td>{m.roadLevel ? (ROAD_LEVEL_LABEL as Record<string, string>)[m.roadLevel] : '—'}</td>
                              <td className="mono">{m.distanceKm}</td>
                              <td className="mono">{m.avgSpeedKmh}</td>
                              <td className="mono">{m.gradePercent}</td>
                              <td className="mono">{m.elevationM}</td>
                              <td className="mono">{m.temperatureC}</td>
                              <td className="mono">{m.windSpeedKmh != null ? m.windSpeedKmh : '—'}</td>
                              <td className="mono">{m.windDirText || '—'}</td>
                              <td className="mono hydro-strong">{(m.h2_per_km_kg * 100).toFixed(2)}</td>
                              <td className="mono">{m.h2_kg}</td>
                              <td className="mono">{m.v_p85}</td>
                              <td className="mono">{m.e_acc}</td>
                              <td className="mono">{m.e_aero}</td>
                              <td className="mono">{m.e_grade_up}</td>
                              <td className="mono">{m.absa_mean}</td>
                              <td className="mono">{m.cruise_ratio}</td>
                              <td className="mono">{m.stop_ratio}</td>
                              <td className="mono">{m.v_std}</td>
                              <td className="mono">{m.a_p90}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
                <div className="hydro-table-wrap">
                  <div className="hydro-table-head">
                    <span>🔧 物理模型 · 路段中间变量明细（{phSegs.length} 段）<span className="table-tip">点击表头排序（# = 起点→终点顺序）</span></span>
                    <button className="btn-export" onClick={exportPhysicsCsv} disabled={!phSegs.length}>⬇ 导出 CSV</button>
                  </div>
                  <div className="hydro-table-scroll">
                    <table className="hydro-table">
                      <thead><tr>
                        <th className="sortable" onClick={() => phSort('index')}>#（顺序）{phArrow('index')}</th>
                        <th>道路</th>
                        {phCols.map((c) => <th key={c.key} className="sortable" title={c.tip} onClick={() => phSort(c.key)}>{c.cn}{phArrow(c.key)}</th>)}
                        <th className="sortable" onClick={() => phSort('h2_per_km_kg')}>氢耗kg/100km{phArrow('h2_per_km_kg')}</th>
                        <th className="sortable" onClick={() => phSort('h2_kg')}>氢耗kg{phArrow('h2_kg')}</th>
                      </tr></thead>
                      <tbody>
                        {phSorted.map((p: any) => (
                          <tr key={p.index}>
                            <td className="mono">{p.index}</td>
                            <td className="road-name">
                              {p.roadName || '—'}
                              {p.grade_missing && <span title="该段无坡度数据，物理模型按平路(0%)计算，山区可能低估氢耗" style={{ color: '#ffb547', marginLeft: 4 }}>⚠</span>}
                            </td>
                            {phCols.map((c) => <td key={c.key} className="mono">{p[c.key]}</td>)}
                            <td className="mono hydro-strong">{p.h2_per_km_kg != null ? (p.h2_per_km_kg * 100).toFixed(2) : '—'}</td>
                            <td className="mono">{p.h2_kg}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="hydro-metrics">
                  <div className="hydro-metric"><b>{hydroResult.total_h2_kg?.toFixed(2)}</b><span>总氢耗 kg</span></div>
                  <div className="hydro-metric"><b>{hydroResult.per100km_kg?.toFixed(2)}</b><span>百公里 kg/100km</span></div>
                  <div className="hydro-metric"><b>{segments.length}</b><span>路段数</span></div>
                </div>
                <div className="hydro-note">💡 参考：49 吨氢能重卡满载百公里约 5~9 kg；本结果已按你输入的载重（{massMode === 'fixed' ? fixedLoadT + ' t' : '重量曲线'}）参与预测，载重/驾驶习惯会影响实际值。红线标记为高耗路段（超过 8 kg/100km 或超过均值 1.5 倍）。</div>
                <div className="hydro-src-note">
                  <b>本次预测数据来源（兜底透明）：</b>
                  温度/湿度/风速：{weatherOk ? '真实抓到 ' + weatherSampled + ' 段' : '⚠️ 未全量匹配（' + weatherSampled + '/' + segments.length + '），已用默认值 20℃/60%/10km/h 兜底'}
                  · 道路等级：OSM {osmCount} 段 + 规则推断 {segments.length - osmCount} 段
                  · 坡度/海拔：DEM {demCount}/{segments.length} 段
                  {hasFallback && ' · 有兜底项，结果精度受影响，仅供参考'}
                </div>
                <div className="hydro-chart">
                  <LineAreaChartMemo points={hydroPts} color="#3ae3ff" yLabel="每公里氢耗" unit="kg/100km" markers={hydroMarkers} />
                </div>
                <div className="hydro-table-wrap">
                  <div className="hydro-table-head">
                    <span>路段氢耗明细（{hydroResult.segments?.length ?? 0} 段）<span className="table-tip">点击表头排序（# = 起点→终点顺序）</span></span>
                    <button className="btn-export" onClick={exportHydroCsv} disabled={!hydroResult.segments?.length}>⬇ 导出 CSV</button>
                  </div>
                  <div className="hydro-table-scroll">
                    <table className="hydro-table">
                      <thead>
                        <tr>
                          <th className="sortable" onClick={() => headerSortHydro('index')}>#（路线顺序）{sortArrowHydro('index')}</th>
                          <th>道路</th>
                          <th>等级</th>
                          <th className="sortable" onClick={() => headerSortHydro('distanceKm')}>里程km{sortArrowHydro('distanceKm')}</th>
                          <th className="sortable" onClick={() => headerSortHydro('avgSpeedKmh')}>均速 km/h{sortArrowHydro('avgSpeedKmh')}</th>
                          <th className="sortable" onClick={() => headerSortHydro('gradePercent')}>坡度%{sortArrowHydro('gradePercent')}</th>
                          <th className="sortable" onClick={() => headerSortHydro('elevationM')}>海拔m{sortArrowHydro('elevationM')}</th>
                          <th className="sortable" onClick={() => headerSortHydro('temperatureC')}>温度℃{sortArrowHydro('temperatureC')}</th>
                          <th>风速 km/h</th><th>风向</th>
                          <th className="sortable" onClick={() => headerSortHydro('h2_per_km_kg')}>氢耗kg/km{sortArrowHydro('h2_per_km_kg')}</th>
                          <th className="sortable" onClick={() => headerSortHydro('h2_kg')}>氢耗kg{sortArrowHydro('h2_kg')}</th>
                          <th className="sortable" title="巡航速度第85分位(km/h)" onClick={() => headerSortHydro('v_p85')}>巡航速度 v_p85 km/h{sortArrowHydro('v_p85')}</th>
                          <th className="sortable" title="加速能量/km：每公里用于加速的轮边能量" onClick={() => headerSortHydro('e_acc')}>加速能量 e_acc(相对){sortArrowHydro('e_acc')}</th>
                          <th className="sortable" title="空气阻力能量/km：每公里撞开空气的轮边能量(∝v³)，高速重卡最大能量项" onClick={() => headerSortHydro('e_aero')}>空阻能量 e_aero(相对){sortArrowHydro('e_aero')}</th>
                          <th className="sortable" title="上坡能量/km：每公里克服重力爬坡的轮边能量（只计上坡，下坡可回收）" onClick={() => headerSortHydro('e_grade_up')}>上坡能量 e_grade_up(相对){sortArrowHydro('e_grade_up')}</th>
                          <th className="sortable" title="平均加速度强度(m/s²)：加减速平均幅度，反映驾驶激进程度" onClick={() => headerSortHydro('absa_mean')}>平均加速度 absa m/s²{sortArrowHydro('absa_mean')}</th>
                          <th className="sortable" title="巡航占比：平稳行驶(|a|<0.15)时间占比，高=电堆高效区多=省氢" onClick={() => headerSortHydro('cruise_ratio')}>巡航占比 cruise 0~1{sortArrowHydro('cruise_ratio')}</th>
                          <th className="sortable" title="停车占比：车速<1km/h 时间占比，高=起步频繁+附件时间摊薄=费氢" onClick={() => headerSortHydro('stop_ratio')}>停车占比 stop 0~1{sortArrowHydro('stop_ratio')}</th>
                          <th className="sortable" title="速度标准差(km/h)：速度波动程度，区分匀速巡航与走走停停" onClick={() => headerSortHydro('v_std')}>速度波动 v_std km/h{sortArrowHydro('v_std')}</th>
                          <th className="sortable" title="强加速水平(m/s²)：最猛10%时刻的加速度，捕捉急加速/急刹车" onClick={() => headerSortHydro('a_p90')}>强加速 a_p90 m/s²{sortArrowHydro('a_p90')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {hydroSorted.map((s) => (
                          <tr key={s.index}>
                            <td className="mono">{s.index}</td>
                            <td className="road-name">{s.roadName || '—'}</td>
                            <td>{s.roadLevel ? (ROAD_LEVEL_LABEL as Record<string, string>)[s.roadLevel] : '—'}</td>
                            <td className="mono">{s.distanceKm}</td>
                            <td className="mono">{s.avgSpeedKmh}</td>
                            <td className="mono">{s.gradePercent}</td>
                            <td className="mono">{s.elevationM}</td>
                            <td className="mono">{s.temperatureC}</td>
                            <td className="mono">{s.windSpeedKmh != null ? s.windSpeedKmh : '—'}</td>
                            <td className="mono">{s.windDirText || '—'}</td>
                            <td className="mono hydro-strong">{(s.h2_per_km_kg * 100).toFixed(2)}</td>
                            <td className="mono">{s.h2_kg}</td>
                            <td className="mono">{s.v_p85}</td>
                            <td className="mono">{s.e_acc}</td>
                            <td className="mono">{s.e_aero}</td>
                            <td className="mono">{s.e_grade_up}</td>
                            <td className="mono">{s.absa_mean}</td>
                            <td className="mono">{s.cruise_ratio}</td>
                            <td className="mono">{s.stop_ratio}</td>
                            <td className="mono">{s.v_std}</td>
                            <td className="mono">{s.a_p90}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>}

      {resultTab === 'ai' &&
      <div className="ai-card">
        <div className="ai-head">
          <h4>🤖 AI 智能评估</h4>
          {aiModel && <span className="ai-model">{aiModel}</span>}
          {!aiText && !aiLoading && (
            <button className="btn-ai" onClick={runAi} disabled={aiLoading}>开始 AI 评估</button>
          )}
        </div>
        {aiLoading && <div className="panel-loading">AI 正在分析路线数据…</div>}
        {aiError && <div className="error">{aiError}</div>}
        {aiText && (
          <>
            <div className="ai-copy-bar">
              <button className="btn-copy" onClick={() => { navigator.clipboard.writeText(aiText); }}>
                📋 一键复制
              </button>
            </div>
            <MarkdownLight text={aiText} />
          </>
        )}
      </div>}

      {showHowItWorks && <HydrogenHowItWorks onClose={() => setShowHowItWorks(false)} />}
    </div>
  )
}
