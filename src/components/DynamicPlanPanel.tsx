/**
 * 动态规划面板：路线 + 车速 + 氢电双补能 DP + 动态重规划
 * 后端 /api/plan/start | /api/plan/status | /api/plan/result（异步 job，避免长请求超时）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { LineAreaChartMemo } from './Charts'
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
        body: JSON.stringify({ origin, destination, lambda }),
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
  }, [origin, destination, lambda])

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
              <div className="table-head">
                动态重规划演示：行驶至 {plan.replan.event.atKm} km 时，前方 {plan.replan.event.lengthKm} km 突发{plan.replan.event.type}（{plan.replan.event.effect}）
              </div>
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
