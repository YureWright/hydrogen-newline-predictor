/**
 * 动态规划独立页面（首页入口）：输入起终点 + 偏好 → 自动规划
 * 规划结果复用 DynamicPlanPanel（autoStart）。
 */
import { useCallback, useState } from 'react'
import DynamicPlanPanel from './DynamicPlanPanel'

interface Props {
  onBack: () => void
}

interface GeoPoint {
  name: string
  lng: number
  lat: number
}

async function geocode(address: string): Promise<GeoPoint> {
  const r = await fetch('/api/geocode?address=' + encodeURIComponent(address))
  const j: any = await r.json()
  if (j?.ok && j.location) {
    const [lng, lat] = String(j.location).split(',').map(Number)
    return { name: j.name || address, lng, lat }
  }
  throw new Error(j?.msg || '地址解析失败：' + address)
}

export default function DynamicPlanPage({ onBack }: Props) {
  const [fromAddr, setFromAddr] = useState('武汉市')
  const [toAddr, setToAddr] = useState('恩施野三关')
  const [lambda, setLambda] = useState(100)
  const [origin, setOrigin] = useState('')
  const [destination, setDestination] = useState('')
  const [names, setNames] = useState<{ from: string; to: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = useCallback(async () => {
    if (!fromAddr.trim() || !toAddr.trim()) {
      setErr('请填写起点和终点')
      return
    }
    setBusy(true)
    setErr('')
    setOrigin('')
    setDestination('')
    setNames(null)
    try {
      const f = await geocode(fromAddr.trim())
      const t = await geocode(toAddr.trim())
      setNames({ from: f.name, to: t.name })
      setOrigin(f.lng + ',' + f.lat)
      setDestination(t.lng + ',' + t.lat)
    } catch (e: any) {
      setErr(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }, [fromAddr, toAddr])

  return (
    <div className="app app-query">
      <div className="query-topbar">
        <span className="topbar-title">🧭 动态规划</span>
        <span className="topbar-sub">时间-费用偏好 · 路线 / 车速 / 氢电双补能</span>
        <button className="topbar-btn" onClick={onBack}>← 首页</button>
      </div>
      <main className="main main-query" style={{ maxWidth: 1200 }}>
        <div className="plan-form">
          <div className="plan-form-row">
            <label>起点</label>
            <input value={fromAddr} onChange={(e) => setFromAddr(e.target.value)} placeholder="输入起点地址，如：武汉市" />
            <label>终点</label>
            <input value={toAddr} onChange={(e) => setToAddr(e.target.value)} placeholder="输入终点地址，如：恩施野三关" />
          </div>
          <div className="plan-form-row">
            <label>偏好</label>
            <span className="plan-form-hint">费用优先</span>
            <input type="range" min={0} max={300} step={10} value={lambda} onChange={(e) => setLambda(Number(e.target.value))} />
            <span className="plan-form-hint">时间优先</span>
            <b className="plan-form-lambda">λ = {lambda} 元/h</b>
            <button className="btn-primary" onClick={submit} disabled={busy}>
              {busy ? '解析地址中…' : '开始规划'}
            </button>
          </div>
          {err && <div className="error">{err}</div>}
        </div>

        {origin && destination && names ? (
          <DynamicPlanPanel
            origin={origin}
            destination={destination}
            originName={names.from}
            destinationName={names.to}
            initialLambda={lambda}
            autoStart
          />
        ) : (
          <div className="idle-panel">
            <div className="idle-head">选择起终点与偏好，点击「开始规划」</div>
            <p className="note">
              系统将自动规划路线、逐段计算经济车速，并在加氢站与充电站之间做双补能动态规划，
              同时给出一次「前方拥堵」的动态重规划演示。首次规划约需 30~90 秒。
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
