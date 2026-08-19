import { useCallback, useEffect, useState } from 'react'
import MapView, { type MapPoint } from './components/MapView'
import RouteCard from './components/RouteCard'
import SegmentsPanel from './components/SegmentsPanel'
import type { RouteCandidate, H2Station } from './route/types'

interface GeoResult { ok: boolean; name?: string; location?: string; source?: string; msg?: string }
interface RouteResult { ok: boolean; routes?: RouteCandidate[]; msg?: string }

export default function App() {
  const [fromAddr, setFromAddr] = useState('乌兰察布')
  const [toAddr, setToAddr] = useState('天津')
  const [from, setFrom] = useState<MapPoint | null>(null)
  const [to, setTo] = useState<MapPoint | null>(null)
  const [routes, setRoutes] = useState<RouteCandidate[]>([])
  const [selected, setSelected] = useState(0)
  const [stations, setStations] = useState<H2Station[]>([])
  /** 高亮路段列表（每条 WGS-84 [lng,lat][]，勾选路段表格行设置；空数组=不高亮） */
  const [highlight, setHighlight] = useState<Array<Array<[number, number]>>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    fetch('/api/stations').then((r) => r.json()).then((j) => {
      // 接口已带 id/useType（1=商用 2=自用），不能覆写——否则自用站会被全部画成商用蓝点
      if (j.ok) setStations(j.stations as H2Station[])
    }).catch(() => {})
  }, [])

  const geocode = useCallback(async (address: string): Promise<{ point: MapPoint | null; source?: string }> => {
    const r = await fetch('/api/geocode?address=' + encodeURIComponent(address))
    const j = (await r.json()) as GeoResult
    if (j.ok && j.location) {
      const [lng, lat] = j.location.split(',').map(Number)
      return { point: { name: j.name || address, lng, lat }, source: j.source }
    }
    return { point: null, source: j.source }
  }, [])

  const query = useCallback(async () => {
    setLoading(true); setError(''); setNote('')
    try {
      const f = await geocode(fromAddr)
      const t = await geocode(toAddr)
      if (!f.point || !t.point) {
        setError('地址解析失败：请检查输入，或到高德控制台为 Key 开通"地理编码"权限')
        // 清掉上一次的结果：否则报错的同时旧路线/旧起终点还留在页面上，看起来像新地址查出来的
        setRoutes([]); setFrom(null); setTo(null); setHighlight([])
        return
      }
      setFrom(f.point); setTo(t.point)
      const r = await fetch('/api/route?origin=' + encodeURIComponent(f.point.lng + ',' + f.point.lat) + '&destination=' + encodeURIComponent(t.point.lng + ',' + t.point.lat))
      const j = (await r.json()) as RouteResult
      if (j.ok && j.routes && j.routes.length) {
        setRoutes(j.routes); setSelected(0); setHighlight([])
        if (f.source === 'local-table' || t.source === 'local-table') setNote('提示：部分地址未命中高德地理编码，回退到城市中心点。')
      } else {
        setError(j.msg || '路线查询失败')
        setRoutes([]); setHighlight([])
      }
    } catch (e: any) {
      setError('查询出错：' + (e.message || e))
      setRoutes([]); setHighlight([])
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
              <p className="legend-tip">💡 先点选一条路线，再点「开始测算」提取路段数据；🟦 沿线 20km 加氢站（蓝=商用 / 橙=自用），灰点为全国 571 座加氢站</p>
            </div>
            <div className="map-box">
              <MapView routes={routes} selectedIndex={selected} onSelect={setSelected} from={from} to={to} stations={stations} highlight={highlight} />
            </div>
          </div>
        )}
        {from && to && routes.length > 0 && (
          <SegmentsPanel
            key={selected}
            origin={from.lng + ',' + from.lat}
            destination={to.lng + ',' + to.lat}
            routeIndex={selected}
            candidate={routes[selected]}
            onHighlight={setHighlight}
          />
        )}
      </main>
    </div>
  )
}
