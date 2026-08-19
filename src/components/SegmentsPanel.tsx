/** 路段数据分析面板：选路 → 点「开始测算」→ 真实进度条 → 表格/可视化/AI 评估 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RouteCandidate, SegmentData, SegmentSummary } from '../route/types'
import { ROAD_LEVEL_LABEL, expectedStopCount } from '../route/segment'
import { DistributionBarsMemo, LineAreaChartMemo, StackedBarMemo } from './Charts'
import MarkdownLight from './MarkdownLight'

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
type Stage = 'idle' | 'running' | 'done' | 'error'

/** 模块级常量：无数据时的稳定空数组引用（见下方 segments 的说明） */
const EMPTY_SEGMENTS: SegmentData[] = []

const PHASE_TEXT: Record<string, string> = {
  route: '获取路线分段…',
  dem: '下载高程瓦片…',
  'osm-query': '查询 OSM 真实路网…',
  'osm-match': 'OSM 道路匹配…',
  weather: '抓取沿线天气（按出发时间匹配）…',
  compute: '计算坡度与海拔…',
}

export default function SegmentsPanel({ origin, destination, routeIndex, candidate, onHighlight }: {
  origin: string
  destination: string
  routeIndex: number
  candidate: RouteCandidate
  /** 勾选路段行 → 在左侧地图同时高亮多条路段（每条 WGS-84 折线；空数组=清除） */
  onHighlight?: (coordsList: Array<Array<[number, number]>>) => void
}) {
  const [stage, setStage] = useState<Stage>('idle')
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
  const [aiModel, setAiModel] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const jobIdRef = useRef('')
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
      // 请求在途期间用户已经取消/切走：把刚建好的后台任务停掉，别让它白跑几分钟
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

  /* ---------- 未测算：开始按钮 ---------- */
  if (stage === 'idle') {
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
            <button className="btn-primary" onClick={start}>开始测算</button>
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
    return (
      <div className="segments-panel running-panel">
        <div className="truck-watermark" aria-hidden="true" />
        <h3>正在测算路线 {routeIndex + 1}</h3>
        <div className="progress-box">
          <div className="progress-track">
            <div
              className={'progress-fill' + (pct == null ? ' indeterminate' : '')}
              style={pct != null ? { width: pct + '%' } : undefined}
            />
          </div>
          <div className="progress-text">{phaseText}</div>
          <div className="progress-sub">
            {total > 0 ? `${pct}% · 首次下载后本地缓存，同路线重复测算秒级` : '正在获取路线分段…'}
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

  return (
    <div className="segments-panel">
      <div className="panel-title">
        <button className="btn-back" onClick={backToSelect}>← 换一条路线</button>
        {selectedSegs.size > 0 && (
          <button className="btn-back btn-clear-hl" onClick={() => setSelectedSegs(new Set())}>✕ 清除高亮（{selectedSegs.size}）</button>
        )}
        <h3>路段数据分析（{segments.length} 段）</h3>
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
                <th>湿度 %</th>
                <th>降水 mm</th>
                <th>天气</th>
                <th>爬升 m</th>
                <th>下降 m</th>
                <th>变速情况</th>
                <th>变速概率/期望</th>
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
      </div>

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
        {aiText && <MarkdownLight text={aiText} />}
      </div>
    </div>
  )
}
