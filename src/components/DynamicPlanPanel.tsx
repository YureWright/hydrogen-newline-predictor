/**
 * 动态规划面板：路线 + 车速 + 氢电双补能 DP + 动态重规划
 * 后端 /api/plan/start | /api/plan/status | /api/plan/result（异步 job，避免长请求超时）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { LineAreaChartMemo } from './Charts'
import MapView, { type MapPoint } from './MapView'
import { fetchJson } from '../lib/fetchJson'

interface Props {
  origin: string
  destination: string
  originName?: string
  destinationName?: string
  initialLambda?: number
  autoStart?: boolean
}

type Status = 'idle' | 'running' | 'done' | 'error'

export default function DynamicPlanPanel({ origin, destination, originName, destinationName, initialLambda, autoStart }: Props) {
  const [lambda, setLambda] = useState(initialLambda ?? 100)
  const [status, setStatus] = useState<Status>('idle')
  const [phase, setPhase] = useState('')
  const [plan, setPlan] = useState<any>(null)
  const [error, setError] = useState('')
  const [sortKey, setSortKey] = useState<string>('index')
  const [sortDesc, setSortDesc] = useState(false)
  const [replanAt, setReplanAt] = useState(40)
  const [replanSpeed, setReplanSpeed] = useState(0.7)
  const timer = useRef<number>(0)
  const autoStarted = useRef(false)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const start = useCallback(async () => {
    window.clearTimeout(timer.current)
    setStatus('running')
    setPhase('提交任务…')
    setError('')
    setPlan(null)
    try {
      const r = await fetchJson<any>('/api/plan/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin, destination, lambda, replanAt, replanSpeed }),
      })
      if (!r.ok) throw new Error(r.msg || '启动失败')
      const jobId = r.jobId
      const poll = async () => {
        try {
          const s = await fetchJson<any>('/api/plan/status?jobId=' + encodeURIComponent(jobId))
          if (!s.ok) throw new Error(s.msg || '任务丢失')
          setPhase(s.phase || '规划中')
          if (s.status === 'done') {
            const res = await fetchJson<any>('/api/plan/result?jobId=' + encodeURIComponent(jobId))
            if (!res.ok) throw new Error(res.msg || '结果读取失败')
            setPlan(res)
            setStatus('done')
          } else if (s.status === 'error') {
            throw new Error(s.error || '规划失败')
          } else {
            timer.current = window.setTimeout(poll, 1500)
          }
        } catch (e: any) {
          setStatus('error')
          setError(e?.message || String(e))
        }
      }
      poll()
    } catch (e: any) {
      setStatus('error')
      setError(e?.message || String(e))
    }
  }, [origin, destination, lambda, replanAt, replanSpeed])

  // 独立页面传入 autoStart 时，进入即自动开始一次
  useEffect(() => {
    if (autoStart && !autoStarted.current) {
      autoStarted.current = true
      start()
    }
  }, [autoStart, start])

  const speedPts = plan
    ? (() => {
        let d = 0
        return plan.speedPlan.map((s: any) => {
          d += s.distanceKm
          return { x: Math.round(d * 10) / 10, y: s.speed }
        })
      })()
    : []

  const mapFrom: MapPoint | null = plan?.route?.from
    ? (() => {
        const [lng, lat] = String(plan.route.from).split(',').map(Number)
        return { name: originName || '起点', lng, lat }
      })()
    : null
  const mapTo: MapPoint | null = plan?.route?.to
    ? (() => {
        const [lng, lat] = String(plan.route.to).split(',').map(Number)
        return { name: destinationName || '终点', lng, lat }
      })()
    : null
  const mapCandidate: any = plan?.route?.polyline
    ? {
        distanceKm: plan.route.distanceKm,
        durationH: plan.route.durationH,
        tollsYuan: plan.route.tollsYuan,
        tollDistanceKm: 0,
        highwayRatio: 0,
        avgSpeedKmh: plan.route.distanceKm / Math.max(plan.route.durationH, 0.01),
        traffic: { smoothKm: 0, slowKm: 0, congestedKm: 0, severeKm: 0, unknownKm: 0, congestionRatio: 0, totalKm: plan.route.distanceKm },
        polyline: plan.route.polyline,
        topRoads: plan.route.topRoads || [],
        stepsCount: 0,
      }
    : null

  const sortedSegs = (() => {
    if (!plan?.speedPlan) return []
    const arr = [...plan.speedPlan]
    arr.sort((a: any, b: any) => {
      const va = a[sortKey], vb = b[sortKey]
      if (va == null || vb == null) return va == null ? 1 : -1
      const r = typeof va === 'string' ? String(va).localeCompare(String(vb), 'zh') : Number(va) - Number(vb)
      return sortDesc ? -r : r
    })
    return arr
  })()
  const sortArrow = (k: string) => (sortKey === k ? (sortDesc ? ' ↓' : ' ↑') : '')
  const clickSort = (k: string) => {
    if (sortKey === k) setSortDesc(!sortDesc)
    else { setSortKey(k); setSortDesc(false) }
  }

  return (
    <div className="plan-panel">
      <div className="panel-title">🧭 动态规划 · 路线 / 车速 / 氢电双补能</div>
      <p className="note">
        按你的时间—费用偏好，逐段计算经济车速，并在加氢站与充电站之间做双补能动态规划（含绕行与充电时间）。
        规划约需 30~90 秒（沿线 DEM、天气与物理仿真）。
      </p>

      <div className="plan-controls">
        <div className="plan-route">{originName || origin} → {destinationName || destination}</div>
        <div className="plan-slider">
          <span>费用优先</span>
          <input
            type="range" min={0} max={300} step={10} value={lambda}
            onChange={(e) => setLambda(Number(e.target.value))}
          />
          <span>时间优先</span>
          <b>λ = {lambda} 元/h</b>
        </div>
        <div className="plan-slider">
          <span>偏差位置</span>
          <input type="range" min={10} max={80} step={5} value={replanAt}
            onChange={(e) => setReplanAt(Number(e.target.value))} />
          <b>{replanAt}%</b>
        </div>
        <div className="plan-slider">
          <span>限速系数</span>
          <input type="range" min={0.5} max={1} step={0.05} value={replanSpeed}
            onChange={(e) => setReplanSpeed(Number(e.target.value))} />
          <b>×{replanSpeed.toFixed(2)}</b>
        </div>
        <button className="btn-primary" onClick={start} disabled={status === 'running'}>
          {status === 'running' ? '规划中…' : status === 'done' ? '重新规划' : '开始动态规划'}
        </button>
      </div>

      {status === 'running' && (
        <div className="progress-box">
          <div className="progress-text">{phase}</div>
          <div className="road-track"><i className="road-fill" style={{ width: '60%' }} /></div>
          <div className="progress-sub">正在调用高德路线、DEM 高程、沿线天气与物理模型…</div>
        </div>
      )}
      {status === 'error' && <div className="error">规划失败：{error}</div>}

      {status === 'done' && plan && (
        <>
          <div className="stat-cards">
            <div className="stat-card"><b>{plan.total.km.toFixed(1)}</b><span>总里程 km</span></div>
            <div className="stat-card"><b>{(plan.total.timeH + (plan.total.chargeH || 0)).toFixed(2)}</b><span>总时长 h</span></div>
            <div className="stat-card"><b>{(plan.total.planCost || 0).toFixed(0)}</b><span>广义总成本 元</span></div>
            <div className="stat-card"><b>{(plan.total.h2UsedKg || 0).toFixed(1)}</b><span>氢耗 kg</span></div>
            <div className="stat-card"><b>{(plan.total.batUsedKWh || 0).toFixed(1)}</b><span>电池用电 kWh</span></div>
            <div className="stat-card"><b>{plan.stops?.length ?? 0}</b><span>补能次数</span></div>
          </div>

          {mapCandidate && mapFrom && mapTo && (
            <div className="plan-map">
              <h4>路线走向（起点 → 终点）</h4>
              <div className="map-box">
                <MapView
                  routes={[mapCandidate]}
                  selectedIndex={0}
                  onSelect={() => {}}
                  from={mapFrom}
                  to={mapTo}
                  stations={[]}
                />
              </div>
            </div>
          )}

          <div className="chart-card chart-wide">
            <h4>车速规划（逐段经济车速 km/h）</h4>
            <LineAreaChartMemo
              points={speedPts}
              color="#3ae3ff"
              yLabel="车速"
              unit="km/h"
              series={[{ label: '建议车速', color: '#3ae3ff', points: speedPts }]}
              height={260}
            />
          </div>

          <div className="table-card">
            <div className="table-head">分段建议速度（点击表头排序）</div>
            <div className="table-scroll">
              <table className="seg-table">
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => clickSort('index')}>段{sortArrow('index')}</th>
                    <th>道路</th>
                    <th className="sortable" onClick={() => clickSort('distanceKm')}>里程km{sortArrow('distanceKm')}</th>
                    <th className="sortable" onClick={() => clickSort('speed')}>建议车速km/h{sortArrow('speed')}</th>
                    <th className="sortable" onClick={() => clickSort('gradePercent')}>坡度%{sortArrow('gradePercent')}</th>
                    <th className="sortable" onClick={() => clickSort('elevationM')}>海拔m{sortArrow('elevationM')}</th>
                    <th className="sortable" onClick={() => clickSort('temperatureC')}>温度℃{sortArrow('temperatureC')}</th>
                    <th className="sortable" onClick={() => clickSort('windSpeedKmh')}>风速km/h{sortArrow('windSpeedKmh')}</th>
                    <th>路况</th>
                    <th className="sortable" onClick={() => clickSort('h2Kg')}>氢耗kg{sortArrow('h2Kg')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedSegs.map((s: any) => (
                    <tr key={s.index}>
                      <td>{s.index}</td>
                      <td>{s.roadName || '—'}</td>
                      <td>{s.distanceKm?.toFixed(2)}</td>
                      <td><b>{s.speed}</b></td>
                      <td>{s.gradePercent == null ? '—' : s.gradePercent.toFixed(2)}</td>
                      <td>{s.elevationM == null ? '—' : Math.round(s.elevationM)}</td>
                      <td>{s.temperatureC == null ? '—' : s.temperatureC.toFixed(1)}</td>
                      <td>{s.windSpeedKmh == null ? '—' : Math.round(s.windSpeedKmh)}</td>
                      <td>{({ smooth: '畅通', slow: '缓行', congested: '拥堵', severe: '严重', unknown: '未知' } as any)[s.trafficStatus] || s.trafficStatus || '—'}</td>
                      <td>{s.h2Kg?.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="table-card">
            <div className="table-head">补能计划（氢 / 电双资源 DP）</div>
            <div className="table-scroll">
              <table className="seg-table">
                <thead><tr><th>位置 km</th><th>站点</th><th>加氢 kg</th><th>充电 kWh</th><th>花费 元</th></tr></thead>
                <tbody>
                  {(plan.stops || []).length === 0 ? (
                    <tr><td colSpan={5} style={{ color: 'var(--green)' }}>全程无需补能（满氢 + 满电已覆盖）</td></tr>
                  ) : (
                    plan.stops.map((s: any, i: number) => (
                      <tr key={i}>
                        <td>{s.s.toFixed(0)}</td><td>{s.name || '—'}</td>
                        <td>{s.h2Kg.toFixed(1)}</td><td>{s.kWh.toFixed(1)}</td><td>{s.cost.toFixed(0)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {plan.replan && (
            <div className="table-card">
              <div className="table-head">🔴 实时规划：偏差检测与滚动重规划</div>
              {plan.replan.trigger && <p className="note">⚠️ {plan.replan.trigger}</p>}
              {plan.replan.instruction && (
                <div className="plan-instruction">
                  <b>📢 司机指令</b>
                  <p>{plan.replan.instruction.text}</p>
                </div>
              )}
              <div className="table-scroll">
                <table className="seg-table">
                  <thead><tr><th>指标</th><th>原方案</th><th>重规划后</th><th>变化</th></tr></thead>
                  <tbody>
                    <tr><td>总时长 h</td><td>{plan.replan.before.timeH}</td><td>{plan.replan.after.timeH}</td><td style={{ color: 'var(--amber)' }}>+{plan.replan.delta.timeMin} 分钟</td></tr>
                    <tr><td>总氢耗 kg</td><td>{plan.replan.before.h2Kg}</td><td>{plan.replan.after.h2Kg}</td><td>{plan.replan.delta.h2Kg >= 0 ? '+' : ''}{plan.replan.delta.h2Kg} kg</td></tr>
                    <tr><td>电耗 kWh</td><td>{plan.replan.before.energyKWh}</td><td>{plan.replan.after.energyKWh}</td><td>{(plan.replan.after.energyKWh - plan.replan.before.energyKWh).toFixed(1)}</td></tr>
                  </tbody>
                </table>
              </div>
              <p className="note">受影响 {plan.replan.affectedSegments} 段，已重新优化车速；下方为部分路段变化。</p>
              <div className="table-scroll" style={{ maxHeight: 260 }}>
                <table className="seg-table">
                  <thead><tr><th>段</th><th>道路</th><th>里程 km</th><th>原车速 → 新车速</th></tr></thead>
                  <tbody>
                    {plan.replan.changed.slice(0, 20).map((c: any, i: number) => (
                      <tr key={i}><td>{c.index}</td><td>{c.roadName || '—'}</td><td>{c.km.toFixed(1)}</td><td>{c.oldSpeed} → {c.newSpeed} km/h</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="note">
            走廊内匹配加氢站 {plan.stations.filter((s: any) => s.types.includes('h2')).length} 座、
            充电站 {plan.stations.filter((s: any) => s.types.includes('elec')).length} 座。
            充电价格按 1.2 元/kWh、功率按 120kW 假设（高德 POI 不含价格/功率）。
          </p>
        </>
      )}
    </div>
  )
}
