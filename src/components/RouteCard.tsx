import type { RouteCandidate } from '../route/types'

export default function RouteCard({ route, index, selected, onSelect }: {
  route: RouteCandidate
  index: number
  selected: boolean
  onSelect: () => void
}) {
  const t = route.traffic
  return (
    <div className={'route-card' + (selected ? ' selected' : '')} onClick={onSelect}>
      <div className="route-head">
        <span className="route-badge">路线 {index + 1}</span>
        <span className="route-dist">{route.distanceKm} km</span>
        <span className="route-time">约 {route.durationH} h</span>
        <span className="route-toll">过路费 ¥{route.tollsYuan}</span>
      </div>
      <div className="route-metrics">
        <div className="metric"><b>{route.avgSpeedKmh}</b><span>均速 km/h</span></div>
        <div className="metric"><b>{(route.highwayRatio * 100).toFixed(0)}%</b><span>高速占比</span></div>
        <div className="metric"><b>{(t.congestionRatio * 100).toFixed(1)}%</b><span>拥堵占比</span></div>
      </div>
      <div className="traffic-bar">
        <div className="tb smooth" style={{ width: `${(t.smoothKm / Math.max(t.totalKm, 1)) * 100}%` }} title={`畅通 ${t.smoothKm}km`} />
        <div className="tb slow" style={{ width: `${(t.slowKm / Math.max(t.totalKm, 1)) * 100}%` }} title={`缓行 ${t.slowKm}km`} />
        <div className="tb congested" style={{ width: `${(t.congestedKm / Math.max(t.totalKm, 1)) * 100}%` }} title={`拥堵 ${t.congestedKm}km`} />
        <div className="tb severe" style={{ width: `${(t.severeKm / Math.max(t.totalKm, 1)) * 100}%` }} title={`严重拥堵 ${t.severeKm}km`} />
      </div>
      <div className="traffic-label">
        <span>畅通 {t.smoothKm}km</span><span>缓行 {t.slowKm}</span><span>拥堵 {t.congestedKm}</span><span>严重 {t.severeKm}</span>
      </div>
      <div className="route-roads">{route.topRoads.slice(0, 4).join(' → ') || '—'}</div>
    </div>
  )
}
