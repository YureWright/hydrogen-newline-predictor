/** 路段数据分析面板：选路 → 点「开始测算」→ 真实进度条 → 表格/可视化/AI 评估 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RouteCandidate, SegmentData, SegmentSummary } from '../route/types'
import { expectedStopCount } from '../route/segment'
import { DistributionBars, LineAreaChart, StackedBar } from './Charts'
import MarkdownLight from './MarkdownLight'

interface DemInfo { z: number; tiles: number; source: string }
interface SegmentsResponse {
  ok: boolean
  candidate?: RouteCandidate
  segments?: SegmentData[]
  summary?: SegmentSummary
  dem?: DemInfo
  msg?: string
}
interface JobStatus { ok: boolean; status?: string; phase?: string; done?: number; total?: number; cached?: number; error?: string; msg?: string }
interface AiResponse { ok: boolean; text?: string; model?: string; msg?: string }

const ROAD_LEVEL_LABEL: Record<string, string> = {
  highway: '高速', national: '国道', provincial: '省道', city: '城市', other: '其他',
}
const ROAD_LEVEL_COLOR: Record<string, string> = {
  highway: '#1e7a54', national: '#2c7fb8', provincial: '#f0ad4e', city: '#9467bd', other: '#bbb',
}
const TRAFFIC_LABEL: Record<string, string> = {
  smooth: '畅通', slow: '缓行', congested: '拥堵', severe: '严重拥堵', unknown: '未知',
}
const TRAFFIC_COLOR: Record<string, string> = {
  smooth: '#2ca02c', slow: '#f0ad4e', congested: '#d62728', severe: '#7b1fa2', unknown: '#ccc',
}

const MOTION_LABEL: Record<string, string> = {
  cruise: '巡航', toll: '收费站', intersection: '路口', ramp: '匝道', turn: '转弯', serviceArea: '服务区', urbanStopStart: '城市起停',
}
const MOTION_COLOR: Record<string, string> = {
  cruise: '#9aa', toll: '#d62728', intersection: '#ff7f0e', ramp: '#2c7fb8', turn: '#9467bd', serviceArea: '#2ca02c', urbanStopStart: '#8c564b',
}
const MOTION_MARK: Record<string, { label: string; color: string }> = {
  toll: { label: '费', color: '#d62728' },
  intersection: { label: '口', color: '#ff7f0e' },
  ramp: { label: '匝', color: '#2c7fb8' },
  turn: { label: '弯', color: '#9467bd' },
  serviceArea: { label: '服', color: '#2ca02c' },
  urbanStopStart: { label: '起停', color: '#8c564b' },
}

type SortKey = 'index' | 'distanceKm' | 'gradePercent' | 'elevationM' | 'avgSpeedKmh'
type Stage = 'idle' | 'running' | 'done' | 'error'

const PHASE_TEXT: Record<string, string> = {
  route: '获取路线分段…',
  dem: '下载高程瓦片…',
  compute: '计算坡度与海拔…',
}

export default function SegmentsPanel({ origin, destination, routeIndex, candidate }: {
  origin: string
  destination: string
  routeIndex: number
  candidate: RouteCandidate
}) {
  const [stage, setStage] = useState<Stage>('idle')
  const [data, setData] = useState<SegmentsResponse | null>(null)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number; cached: number } | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('distanceKm')
  const [sortDesc, setSortDesc] = useState(true)
  const [aiText, setAiText] = useState('')
  const [aiModel, setAiModel] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const jobIdRef = useRef('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null } }

  // 卸载/换路线时取消任务
  useEffect(() => {
    return () => {
      clearTimer()
      if (jobIdRef.current) {
        fetch('/api/segments/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId: jobIdRef.current }),
        }).catch(() => {})
      }
    }
  }, [])

  const backToSelect = useCallback(() => {
    clearTimer()
    if (jobIdRef.current) {
      fetch('/api/segments/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: jobIdRef.current }),
      }).catch(() => {})
      jobIdRef.current = ''
    }
    setStage('idle')
    setData(null)
    setError('')
    setProgress(null)
    setAiText('')
    setAiModel('')
    setAiError('')
  }, [])

  const start = useCallback(async () => {
    setStage('running')
    setError('')
    setProgress({ phase: 'route', done: 0, total: 0, cached: 0 })
    try {
      const r = await fetch('/api/segments/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin, destination, index: routeIndex }),
      })
      const j = await r.json()
      if (!j.ok || !j.jobId) { setError(j.msg || '启动测算失败'); setStage('error'); return }
      jobIdRef.current = j.jobId
      poll(j.jobId)
    } catch (e: any) {
      setError('启动测算失败：' + (e.message || e))
      setStage('error')
    }
  }, [origin, destination, routeIndex])

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

  const segments = data?.segments ?? []
  const summary = data?.summary

  const sorted = useMemo(() => {
    const arr = [...segments]
    arr.sort((a, b) => {
      const av = a[sortKey] ?? 0
      const bv = b[sortKey] ?? 0
      return (av < bv ? -1 : av > bv ? 1 : 0) * (sortDesc ? -1 : 1)
    })
    return arr
  }, [segments, sortKey, sortDesc])

  const profile = useMemo(() => {
    let cum = 0
    const distKm: number[] = []
    const elevM: number[] = []
    for (const s of segments) {
      if (s.profile && s.profile.distKm.length) {
        for (let i = 0; i < s.profile.distKm.length; i++) {
          distKm.push(Math.round((cum + s.profile.distKm[i]) * 10) / 10)
          elevM.push(s.profile.elevM[i])
        }
      }
      cum += s.distanceKm
    }
    return { distKm, elevM }
  }, [segments])

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

  const speedPts = useMemo(() => {
    let cum = 0
    return segments.map((s) => {
      cum += s.distanceKm
      return { x: Math.round(cum * 10) / 10, y: s.avgSpeedKmh }
    })
  }, [segments])

  const trafficItems = candidate.traffic
  const roadLevelItems = summary ? [
    { label: '高速', value: summary.roadLevelKm.highway, color: ROAD_LEVEL_COLOR.highway },
    { label: '国道', value: summary.roadLevelKm.national, color: ROAD_LEVEL_COLOR.national },
    { label: '省道', value: summary.roadLevelKm.provincial, color: ROAD_LEVEL_COLOR.provincial },
    { label: '城市', value: summary.roadLevelKm.city, color: ROAD_LEVEL_COLOR.city },
    { label: '其他', value: summary.roadLevelKm.other, color: ROAD_LEVEL_COLOR.other },
  ] : []

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
        <div className="idle-head">
          <div>
            <h3>路段数据测算</h3>
            <p className="panel-sub">
              已选 路线 {routeIndex + 1} · {candidate.distanceKm}km · 约 {candidate.durationH}h
              <br />将提取 {candidate.stepsCount} 段路段的坡度/海拔/路况数据（首次约 1~2 分钟，之后走缓存秒级）
            </p>
          </div>
          <button className="btn-primary" onClick={start}>开始测算</button>
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
  const maxElev = profile.elevM.length ? Math.max(...profile.elevM) : 0
  const minElev = profile.elevM.length ? Math.min(...profile.elevM) : 0
  const totalGain = segments.reduce((a, s) => a + (s.elevationGainM ?? 0), 0)
  const totalLoss = segments.reduce((a, s) => a + (s.elevationLossM ?? 0), 0)

  return (
    <div className="segments-panel">
      <div className="panel-title">
        <button className="btn-back" onClick={backToSelect}>← 换一条路线</button>
        <h3>路段数据分析（{segments.length} 段）</h3>
        <span className="panel-sub">
          {data.dem?.source === 'terrarium'
            ? `高程源：terrarium z${data.dem.z}（${data.dem.tiles} 张瓦片）`
            : `高程源：opentopodata SRTM90m（terrarium 不可用时兜底）`}
        </span>
      </div>

      <div className="stat-cards">
        <div className="stat-card"><b>{summary?.totalKm ?? candidate.distanceKm} km</b><span>总里程</span></div>
        <div className="stat-card"><b>{summary?.avgSpeedKmh ?? '-'}</b><span>加权均速 km/h</span></div>
        <div className="stat-card"><b>{summary?.avgGradePercent != null ? summary.avgGradePercent + '%' : '-'}</b><span>平均坡度</span></div>
        <div className="stat-card"><b>{summary?.avgElevationM != null ? summary.avgElevationM + ' m' : '-'}</b><span>平均海拔</span></div>
        <div className="stat-card"><b>{totalGain} m</b><span>累计爬升</span></div>
        <div className="stat-card"><b>{totalLoss} m</b><span>累计下降</span></div>
        <div className="stat-card"><b>{maxElev} m</b><span>最高点</span></div>
        <div className="stat-card"><b>{minElev} m</b><span>最低点</span></div>
        <div className="stat-card"><b>{totalStops.toFixed(1)}</b><span>期望停车/启停次数</span></div>
      </div>

      <div className="charts-grid">
        <div className="chart-card chart-wide">
          <h4>海拔剖面</h4>
          <LineAreaChart points={profile.distKm.map((x, i) => ({ x, y: profile.elevM[i] }))} color="#1e7a54" yLabel="海拔" unit="m" markers={motionMarkers} />
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
          <DistributionBars items={roadLevelItems} total={summary?.totalKm ?? 1} unit="" />
        </div>
        <div className="chart-card">
          <h4>实时路况分布</h4>
          <StackedBar items={[
            { label: TRAFFIC_LABEL.smooth, value: trafficItems.smoothKm, color: TRAFFIC_COLOR.smooth },
            { label: TRAFFIC_LABEL.slow, value: trafficItems.slowKm, color: TRAFFIC_COLOR.slow },
            { label: TRAFFIC_LABEL.congested, value: trafficItems.congestedKm, color: TRAFFIC_COLOR.congested },
            { label: TRAFFIC_LABEL.severe, value: trafficItems.severeKm, color: TRAFFIC_COLOR.severe },
            { label: TRAFFIC_LABEL.unknown, value: trafficItems.unknownKm, color: TRAFFIC_COLOR.unknown },
          ]} />
        </div>
        <div className="chart-card chart-wide">
          <h4>分段均速（km/h）</h4>
          <LineAreaChart points={speedPts} color="#2c7fb8" yLabel="均速" unit="km/h" />
        </div>
      </div>

      <div className="table-card">
        <h4>路段数据表 <span className="table-tip">点击「里程 / 坡度 / 海拔 / 均速」排序</span></h4>
        <div className="table-scroll">
          <table className="seg-table">
            <thead>
              <tr>
                <th>#</th>
                <th>道路</th>
                <th>等级</th>
                <th className="sortable" onClick={() => headerSort('distanceKm')}>里程 km{sortArrow('distanceKm')}</th>
                <th className="sortable" onClick={() => headerSort('avgSpeedKmh')}>均速 km/h{sortArrow('avgSpeedKmh')}</th>
                <th className="sortable" onClick={() => headerSort('gradePercent')}>坡度 %{sortArrow('gradePercent')}</th>
                <th className="sortable" onClick={() => headerSort('elevationM')}>海拔 m{sortArrow('elevationM')}</th>
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
                <tr key={s.index}>
                  <td className="mono">{s.index}</td>
                  <td className="road-name" title={s.roadName}>{s.roadName || '—'}</td>
                  <td><span className={'lv ' + s.roadLevel}>{ROAD_LEVEL_LABEL[s.roadLevel]}</span></td>
                  <td className="mono">{s.distanceKm}</td>
                  <td className="mono">{s.avgSpeedKmh}</td>
                  <td className={'mono ' + (s.gradePercent != null ? (s.gradePercent > 1 ? 'grade-up' : s.gradePercent < -1 ? 'grade-down' : '') : '')}>
                    {s.gradePercent != null ? s.gradePercent : '—'}
                  </td>
                  <td className="mono">{s.elevationM != null ? s.elevationM : '—'}</td>
                  <td className="mono">{s.elevationGainM != null ? s.elevationGainM : '—'}</td>
                  <td className="mono">{s.elevationLossM != null ? s.elevationLossM : '—'}</td>
                  <td><span className="motion-chip" style={{ background: MOTION_COLOR[s.motionBehavior] }}>{MOTION_LABEL[s.motionBehavior]}</span></td>
                  <td className="mono motion-events">{s.motionEvents.length ? s.motionEvents.map((e) => `${e.label ?? e.type}×${e.expectedCount}`).join(' ') : '—'}</td>
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
