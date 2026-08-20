import { useCallback, useEffect, useState } from 'react'
import IntroScreen from './components/IntroScreen'
import MapView, { type MapPoint } from './components/MapView'
import RouteCard from './components/RouteCard'
import SegmentsPanel from './components/SegmentsPanel'
import type { RouteCandidate, H2Station } from './route/types'

/** 同一浏览器会话内引导只放一次；换标签或关闭浏览器再进又会看到。
 *  PR#6 换了新钥匙，避免看过 PR#5 平面动效的人直接被跳过、看不到 3D 这一镜。 */
const INTRO_KEY = 'hybot-intro-brand-seen'

interface GeoResult { ok: boolean; name?: string; location?: string; source?: string; msg?: string }
interface RouteResult { ok: boolean; routes?: RouteCandidate[]; msg?: string }

export default function App() {
  // 引导层展示与否：sessionStorage 里有标记就直接跳过，避免同一会话反复出现打扰
  const [showIntro, setShowIntro] = useState(() => {
    try { return sessionStorage.getItem(INTRO_KEY) !== '1' } catch { return true }
  })
  const dismissIntro = useCallback(() => {
    try { sessionStorage.setItem(INTRO_KEY, '1') } catch { /* 隐私模式禁写就算了 */ }
    setShowIntro(false)
  }, [])
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

  /** 空 → 空 的高亮更新直接忽略：避免下游传入新引用的空数组时白白触发一轮重渲染 */
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

  return (
    <div className="app">
      {showIntro && <IntroScreen onEnter={dismissIntro} />}
      {/* 头图整块用海珀特官网主视觉原图（已抹掉官网自带的「预约品鉴」按钮与导航控件），
          logo 和「以氢能创造无限可能 / Hydrogen Powering Infinity」都在图里，
          不另行排版，避免字体/字距跟官方对不上 */}
      <header className="hero">
        <div className="hero-media">
          <div className="hero-scanline" aria-hidden="true" />
          <div className="hero-fade" aria-hidden="true" />
          <div className="hero-inner">
            <div className="hero-rule" />
            <h1>新线路氢耗预测工具</h1>
            <p className="sub">面向 H49 燃料电池半挂牵引车 · 真实路网道路等级 / DEM 坡度剖面 / 沿线逐段天气</p>
            <div className="hero-chips">
              <span><b>OSM</b> 真实路网</span>
              <span><b>DEM</b> 高程剖面</span>
              <span><b>QWeather</b> 沿线天气</span>
              <span><b>DeepSeek</b> AI 评估</span>
            </div>
          </div>
          <span className="hero-tag">T05 · 氢能黑客松</span>
        </div>
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
            onHighlight={applyHighlight}
          />
        )}
      </main>
    </div>
  )
}
