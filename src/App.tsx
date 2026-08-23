import { useCallback, useEffect, useState } from 'react'
import MapView, { type MapPoint } from './components/MapView'
import RouteCard from './components/RouteCard'
import SegmentsPanel from './components/SegmentsPanel'
import LandingPage from './components/LandingPage'
import type { RouteCandidate, H2Station } from './route/types'

type AppView = 'landing' | 'predict'
type PredictStep = 'query' | 'analysis'

interface GeoResult { ok: boolean; name?: string; location?: string; source?: string; msg?: string }
interface RouteResult { ok: boolean; routes?: RouteCandidate[]; msg?: string }

export default function App() {
  const [view, setView] = useState<AppView>(() => {
    return sessionStorage.getItem('h2-skip-landing') === '1' ? 'predict' : 'landing'
  })
  const [predictStep, setPredictStep] = useState<PredictStep>('query')
  // 分析会话计数：前进（query→analysis）时不变，保持同一个 SegmentsPanel 实例让进度延续；
  // 后退（analysis→query「重新选路」）时 +1，强制重建实例，回到干净的「开始测算」状态
  const [analysisSession, setAnalysisSession] = useState(0)

  const [fromAddr, setFromAddr] = useState('乌兰察布')
  const [toAddr, setToAddr] = useState('天津')
  const [from, setFrom] = useState<MapPoint | null>(null)
  const [to, setTo] = useState<MapPoint | null>(null)
  const [routes, setRoutes] = useState<RouteCandidate[]>([])
  const [selected, setSelected] = useState(0)
  const [stations, setStations] = useState<H2Station[]>([])
  const [highlight, setHighlight] = useState<Array<Array<[number, number]>>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const enterPredict = useCallback(() => {
    sessionStorage.setItem('h2-skip-landing', '1')
    setView('predict')
  }, [])

  const applyHighlight = useCallback((list: Array<Array<[number, number]>>) => {
    setHighlight((prev) => (prev.length === 0 && list.length === 0 ? prev : list))
  }, [])

  useEffect(() => {
    fetch('/api/stations').then((r) => r.json()).then((j) => {
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
      }
    } catch (e: any) {
      setError('查询出错：' + (e.message || e))
    } finally {
      setLoading(false)
    }
  }, [fromAddr, toAddr, geocode])

  const handleEnterAnalysis = useCallback(() => setPredictStep('analysis'), [])
  const handleExitAnalysis = useCallback(() => { setPredictStep('query'); setAnalysisSession((s) => s + 1) }, [])
  const goHome = useCallback(() => { sessionStorage.removeItem('h2-skip-landing'); setView('landing') }, [])

  if (view === 'landing') {
    return <LandingPage onStart={enterPredict} />
  }

  const hasRoute = from && to && routes.length > 0
  const inAnalysis = predictStep === 'analysis' && !!hasRoute

  // 单实例架构：query 页与 analysis 页复用同一个 SegmentsPanel 实例（渲染树中位置固定）。
  // 点击「开始测算」时组件内部 start() + 切页，同一实例状态无缝延续，进度条不会丢。
  return (
    <div className={inAnalysis ? 'app app-analysis' : 'app app-query'}>
      {/* 位置 0：背景（仅 query 页） */}
      {!inAnalysis && <div className="query-bg" aria-hidden="true" />}

      {/* 位置 1：顶栏（两页各一套，用 key 强制区分） */}
      {inAnalysis ? (
        <div key="analysis-top" className="analysis-topbar">
          <button className="topbar-btn" onClick={handleExitAnalysis}>← 重新选路</button>
          <span className="topbar-route">
            路线 {selected + 1} · {from!.name} → {to!.name} · {routes[selected].distanceKm} km
          </span>
          <button className="topbar-btn" onClick={goHome}>首页</button>
        </div>
      ) : (
        <div key="query-top" className="query-topbar">
          <span className="topbar-title">新线路氢耗预测工具</span>
          <span className="topbar-sub">H49 燃料电池半挂牵引车 · 真实路网 / DEM 坡度 / 沿线天气</span>
          <button className="topbar-btn" onClick={goHome}>← 首页</button>
        </div>
      )}

      {/* 位置 2：query 页专属内容（analysis 页为 null，保持槽位不动） */}
      {!inAnalysis ? (
        <main className="main main-query">
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
                <p className="legend-tip">💡 先点选一条路线，再点「开始测算」提取路段数据</p>
              </div>
              <div className="map-box">
                <MapView routes={routes} selectedIndex={selected} onSelect={setSelected} from={from} to={to} stations={stations} highlight={highlight} />
              </div>
            </div>
          )}
        </main>
      ) : null}

      {/* 位置 3：SegmentsPanel（两页复用同一实例；key 随路线或分析会话变化时才重建） */}
      {hasRoute ? (
        <SegmentsPanel
          key={`${selected}-${analysisSession}`}
          origin={from!.lng + ',' + from!.lat}
          destination={to!.lng + ',' + to!.lat}
          originName={from!.name}
          destinationName={to!.name}
          routeIndex={selected}
          candidate={routes[selected]}
          onHighlight={applyHighlight}
          onEnterAnalysis={handleEnterAnalysis}
          isFullPage={inAnalysis}
        />
      ) : null}
    </div>
  )
}
