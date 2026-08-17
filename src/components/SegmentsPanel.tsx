/** 路段数据分析面板：点击候选路线后展示 路段数据表 + 可视化 + AI 评估 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RouteCandidate, SegmentData, SegmentSummary } from '../route/types'
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

type SortKey = 'index' | 'distanceKm' | 'gradePercent' | 'elevationM' | 'avgSpeedKmh'

export default function SegmentsPanel({ origin, destination, routeIndex, candidate }: {
  origin: string
  destination: string
  routeIndex: number
  candidate: RouteCandidate
}) {
  const [data, setData] = useState<SegmentsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('distanceKm')
  const [sortDesc, setSortDesc] = useState(true)
  const [aiText, setAiText] = useState('')
  const [aiModel, setAiModel] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    setAiText('')
    setAiModel('')
    setAiError('')
    fetch(
      '/api/segments?origin=' + encodeURIComponent(origin) +
      '&destination=' + encodeURIComponent(destination) +
      '&index=' + routeIndex,
    )
      .then((r) => r.json())
      .then((j: SegmentsResponse) => { if (alive) { setData(j); if (!j.ok) setError(j.msg || '路段数据加载失败') } })
      .catch((e: any) => { if (alive) setError('路段数据加载失败：' + (e.message || e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [origin, destination, routeIndex])

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

  if (loading) return <div className="panel-loading">正在提取路段数据（首次需下载高程瓦片约 1~2 分钟，之后走本地缓存）…</div>
  if (error) return <div className="error">{error}</div>
  if (!data || !segments.length) return <div className="note">该路线暂无分段数据</div>

  const maxElev = profile.elevM.length ? Math.max(...profile.elevM) : 0
  const minElev = profile.elevM.length ? Math.min(...profile.elevM) : 0
  const totalGain = segments.reduce((a, s) => a + (s.elevationGainM ?? 0), 0)
  const totalLoss = segments.reduce((a, s) => a + (s.elevationLossM ?? 0), 0)

  return (
    <div className="segments-panel">
      <div className="panel-title">
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
      </div>

      <div className="charts-grid">
        <div className="chart-card chart-wide">
          <h4>海拔剖面</h4>
          <LineAreaChart points={profile.distKm.map((x, i) => ({ x, y: profile.elevM[i] }))} color="#1e7a54" yLabel="海拔" unit="m" />
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
