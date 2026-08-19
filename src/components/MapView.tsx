import { useEffect, useMemo, useRef } from 'react'
import L from 'leaflet'
import { wgs84ToGcj02 } from '../route/coords'
import type { RouteCandidate, H2Station } from '../route/types'

const TILE_URL = 'https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}'

export interface MapPoint { name: string; lng: number; lat: number }

export function polylineToCoords(polyline: string): Array<[number, number]> {
  return polyline.split(';').filter(Boolean).map((pt) => {
    const [lng, lat] = pt.split(',').map(Number)
    return [lng, lat]
  })
}

/** 点到折线最短距离（km，平面近似） */
function pointToPolylineKm(lng: number, lat: number, coords: Array<[number, number]>): number {
  if (coords.length < 2) return Infinity
  const refLat = coords[Math.floor(coords.length / 2)][1]
  const toM = (x: number, y: number): [number, number] => [x * 111320 * Math.cos((refLat * Math.PI) / 180), y * 110540]
  const [px, py] = toM(lng, lat)
  let best = Infinity
  for (let i = 0; i < coords.length - 1; i++) {
    const [ax, ay] = toM(coords[i][0], coords[i][1])
    const [bx, by] = toM(coords[i + 1][0], coords[i + 1][1])
    const dx = bx - ax, dy = by - ay
    const lenSq = dx * dx + dy * dy
    let t = lenSq ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0
    t = Math.max(0, Math.min(1, t))
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    if (d < best) best = d
  }
  return best / 1000
}

/** 站点悬浮说明：沿线站点显示距线距离与价格/压力/枪数，远处站点只显示站名 */
function stationTooltip(s: H2Station, near: boolean, distKm: number): string {
  if (!near) return s.name
  const parts = [
    '距线' + distKm.toFixed(1) + 'km',
    s.price ? s.price + '元/kg' : null,
    s.pressure || null,
    s.guns != null ? s.guns + ' 枪' : null,
    s.useType === 1 ? '商用' : '自用',
  ].filter(Boolean)
  return s.name + '（' + parts.join(' · ') + '）'
}

interface Props {
  routes: RouteCandidate[]
  selectedIndex: number
  onSelect: (i: number) => void
  from: MapPoint | null
  to: MapPoint | null
  stations: H2Station[]
  /** 高亮路段列表（每条 WGS-84 [lng,lat][]，勾选路段表格行触发；空数组=不高亮） */
  highlight?: Array<Array<[number, number]>>
}

export default function MapView({ routes, selectedIndex, onSelect, from, to, stations, highlight }: Props) {
  const divRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layersRef = useRef<L.LayerGroup | null>(null)

  // 571 座站 × 所选路线数千个折线点的最短距离：只跟路线/站点有关，
  // 缓存后勾选路段（highlight 变化）不再重算，否则每次勾选都要跑上百万次距离计算
  const stationDistKm = useMemo(() => {
    const selCoords = routes[selectedIndex] ? polylineToCoords(routes[selectedIndex].polyline) : []
    if (selCoords.length < 2) return stations.map(() => Infinity)
    return stations.map((s) => pointToPolylineKm(s.lng, s.lat, selCoords))
  }, [routes, selectedIndex, stations])

  useEffect(() => {
    if (!divRef.current || mapRef.current) return
    const map = L.map(divRef.current, { zoomControl: true, attributionControl: false, minZoom: 3, maxZoom: 18 })
    L.tileLayer(TILE_URL, { maxZoom: 18 }).addTo(map)
    layersRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    return () => { map.remove(); mapRef.current = null }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const layers = layersRef.current
    if (!map || !layers) return
    layers.clearLayers()

    const colors = ['#1f77b4', '#2ca02c', '#ff7f0e']
    const bounds: L.LatLngExpression[] = []
    routes.forEach((r, i) => {
      const coords = polylineToCoords(r.polyline).map(([lng, lat]) => [lat, lng] as [number, number])
      if (coords.length > 1) {
        const line = L.polyline(coords, {
          color: colors[i % 3], weight: selectedIndex === i ? 6 : 3, opacity: selectedIndex === i ? 0.95 : 0.6,
        }).addTo(layers)
        line.on('click', () => onSelect(i))
        line.bindTooltip(`路线${i + 1}: ${r.distanceKm}km ${r.durationH}h 高速${(r.highwayRatio * 100).toFixed(0)}%`, { sticky: true })
        bounds.push(coords[0], coords[coords.length - 1])
      }
    })
    if (from) L.circleMarker([from.lat, from.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#0b3d2e', fillOpacity: 1 }).addTo(layers).bindTooltip('起点 ' + from.name)
    if (to) L.circleMarker([to.lat, to.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#d62728', fillOpacity: 1 }).addTo(layers).bindTooltip('终点 ' + to.name)

    // 高亮路段（表格多选）：WGS-84 → GCJ-02 显示，多条用色板区分
    const highlightCoords: Array<Array<[number, number]>> = []
    const HL_COLORS = ['#ffd700', '#ff8c00', '#e91e63', '#9b59b6', '#00bcd4', '#f44336', '#4caf50', '#3f51b5']
    if (highlight) {
      highlight.forEach((coords, hi) => {
        if (!coords || coords.length < 2) return
        const gcj = coords.map(([lng, lat]) => wgs84ToGcj02(lng, lat)).map(([lng, lat]) => [lat, lng] as [number, number])
        highlightCoords.push(gcj)
        const color = HL_COLORS[hi % HL_COLORS.length]
        const hl = L.polyline(gcj, { color, weight: 9, opacity: 0.95 }).addTo(layers)
        hl.bindTooltip('高亮路段 ' + (hi + 1) + '/' + highlight.length, { sticky: true })
        L.circleMarker(gcj[0], { radius: 6, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).addTo(layers)
        L.circleMarker(gcj[gcj.length - 1], { radius: 6, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).addTo(layers)
      })
    }

    stations.forEach((s, si) => {
      const dist = stationDistKm[si] ?? Infinity
      const near = dist <= 20
      L.circleMarker([s.lat, s.lng], {
        radius: near ? 5 : 2.5, color: '#fff', weight: near ? 1 : 0.5,
        fillColor: near ? (s.useType === 1 ? '#1f77b4' : '#ff8c00') : '#b0b8b5', fillOpacity: near ? 0.95 : 0.5,
      }).addTo(layers).bindTooltip(stationTooltip(s, near, dist), { direction: 'top' })
    })
    if (highlightCoords.length > 0) {
      const all = highlightCoords.flat()
      if (all.length >= 2) map.fitBounds(L.latLngBounds(all).pad(0.2))
    } else if (bounds.length) {
      map.fitBounds(L.latLngBounds(bounds).pad(0.15))
    }
  }, [routes, selectedIndex, from, to, stations, stationDistKm, onSelect, highlight])

  return <div ref={divRef} style={{ height: '100%', width: '100%' }} />
}
