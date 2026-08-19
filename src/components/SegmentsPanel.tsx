/** 路段数据分析面板：选路 → 点「开始测算」→ 真实进度条 → 表格/可视化/AI 评估 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RouteCandidate, SegmentData, SegmentSummary } from '../route/types'
import { expectedStopCount } from '../route/segment'
import { DistributionBarsMemo, LineAreaChartMemo, StackedBarMemo } from './Charts'
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
const EVENT_TYPE_LABEL: Record<string, string> = {
  stop: '停止', start: '启动', decel: '减速', turn: '转弯',
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

export default function SegmentsPanel({ origin, destination, routeIndex, candidate, onHighlight }: {
  origin: string
  destination: string
  routeIndex: number
  candidate: RouteCandidate
  /** 勾选路段行 → 在左侧地图同时高亮多条路段（每条 WGS-84 折线；空数组=清除） */
  onHighlight?: (coordsList: Array<Array<[number, number]>>) => void
}) {
  const [stage, setStage] = useState<Stage>('idle')
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
    arr.sort((a, b) => {
      const av = a[sortKey] ?? 0
      const bv = b[sortKey] ?? 0
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
    const header = ['序号', '道路', '等级', '里程km', '均速km/h', '坡度%', '海拔m', '爬升m', '下降m', '变速情况', '变速概率/期望', '路况', '停车次/km', '时长h', '期望停车次数']
    const rows = sorted.map((s) => [
      s.index, s.roadName ?? '', ROAD_LEVEL_LABEL[s.roadLevel], s.distanceKm, s.avgSpeedKmh,
      s.gradePercent ?? '', s.elevationM ?? '', s.elevationGainM ?? '', s.elevationLossM ?? '',
      MOTION_LABEL[s.motionBehavior],
      s.motionEvents.length ? s.motionEvents.map((e) => `${EVENT_TYPE_LABEL[e.type]}${e.expectedCount}`).join(';') : '',
      TRAFFIC_LABEL[s.trafficStatus], s.stopDensity, s.durationH, expectedStopCount(s),
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
        {selectedSegs.size > 0 && (
          <button className="btn-back btn-clear-hl" onClick={() => setSelectedSegs(new Set())}>✕ 清除高亮（{selectedSegs.size}）</button>
        )}
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
          <LineAreaChartMemo points={profilePoints} color="#1e7a54" yLabel="海拔" unit="m" markers={motionMarkers} />
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
          <LineAreaChartMemo points={speedPts} color="#2c7fb8" yLabel="均速" unit="km/h" />
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
