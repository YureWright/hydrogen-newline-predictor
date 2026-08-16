import { useCallback, useEffect, useState } from 'react'
import MapView, { type MapPoint } from './components/MapView'
import RouteCard from './components/RouteCard'
import type { RouteCandidate, H2Station } from './route/types'

interface GeoResult { ok: boolean; name?: string; location?: string; msg?: string }
interface RouteResult { ok: boolean; routes?: RouteCandidate[]; msg?: string }

export default function App() {
  const [fromAddr, setFromAddr] = useState('乌兰察布')
  const [toAddr, setToAddr] = useState('天津')
  const [from, setFrom] = useState<MapPoint | null>(null)
  const [to, setTo] = useState<MapPoint | null>(null)
  const [routes, setRoutes] = useState<RouteCandidate[]>([])
  const [selected, setSelected] = useState(0)
  const [stations, setStations] = useState<H2Station[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    fetch('/api/stations').then((r) => r.json()).then((j) => {
      if (j.ok) setStations(j.stations.map((s: any) => ({ ...s, id: 0, useType: 1 })))
    }).catch(() => {})
  }, [])

  const geocode = useCallback(async (address: string): Promise<MapPoint | null> => {
    const r = await fetch('/api/geocode?address=' + encodeURIComponent(address))
    const j = (await r.json()) as GeoResult
    if (j.ok && j.location) {
      const [lng, lat] = j.location.split(',').map(Number)
      return { name: j.name || address, lng, lat }
    }
    return null
  }, [])

  const query = useCallback(async () => {
    setLoading(true); setError(''); setNote('')
    try {
      const f = await geocode(fromAddr)
      const t = await geocode(toAddr)
      if (!f || !t) {
        setError('地址解析失败：请检查输入，或到高德控制台为 Key 开通"地理编码/输入提示"权限')
        return
      }
      setFrom(f); setTo(t)
      const r = await fetch('/api/route?origin=' + encodeURIComponent(f.lng + ',' + f.lat) + '&destination=' + encodeURIComponent(t.lng + ',' + t.lat))
      const j = (await r.json()) as RouteResult
      if (j.ok && j.routes && j.routes.length) {
        setRoutes(j.routes); setSelected(0)
        if (f.name.includes('内置') || t.name.includes('内置')) setNote('提示：部分地址使用内置城市表解析（高德地理编码权限未开通）。')
      } else {
        setError(j.msg || '路线查询失败')
      }
    } catch (e: any) {
      setError('查询出错：' + (e.message || e))
    } finally {
      setLoading(false)
    }
  }, [fromAddr, toAddr, geocode])

  return (
    <div className="app">
      <header className="hero">
        <h1>新线路氢耗预测工具</h1>
        <p className="sub">氢能车辆运营智能分析与决策助手 · T05 · 路线路况模块 Demo</p>
      </header>
      <main className="main">
        <div className="query-bar">
          <div className="addr-input">
            <label>起点</label>
            <input value={fromAddr} onChange={(e) => setFromAddr(e.target.value)} placeholder="输入城市/地址，如：乌兰察布" />
          </div>
          <button className="swap" onClick={() => { setFromAddr(toAddr); setToAddr(fromAddr) }}>⇄</button>
          <div className="addr-input">
            <label>终点</label>
            <input value={toAddr} onChange={(e) => setToAddr(e.target.value)} placeholder="输入城市/地址，如：天津" />
          </div>
          <button className="btn-primary" onClick={query} disabled={loading}>
            {loading ? '查询中…' : '查询路线'}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        {note && <div className="note">{note}</div>}
        {from && to && <div className="coord-line">起点 {from.name}（{from.lng.toFixed(3)},{from.lat.toFixed(3)}） → 终点 {to.name}（{to.lng.toFixed(3)},{to.lat.toFixed(3)}）</div>}

        {routes.length > 0 && (
          <div className="content">
            <div className="route-list">
              <h2>候选路线（{routes.length} 条）</h2>
              {routes.map((r, i) => (
                <RouteCard key={i} route={r} index={i} selected={selected === i} onSelect={() => setSelected(i)} />
              ))}
              <p className="legend-tip">🟦 选中路线沿途 20km 加氢站（蓝=商用 / 橙=自用）；灰点为全国 571 座加氢站</p>
            </div>
            <div className="map-box">
              <MapView routes={routes} selectedIndex={selected} onSelect={setSelected} from={from} to={to} stations={stations} />
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
