import { useEffect, useRef } from 'react'
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

interface Props {
  routes: RouteCandidate[]
  selectedIndex: number
  onSelect: (i: number) => void
  from: MapPoint | null
  to: MapPoint | null
  stations: H2Station[]
  /** 高亮路段（WGS-84 [lng,lat][]，点击路段表格行触发；null=不高亮） */
  highlight?: Array<[number, number]> | null
}

export default function MapView({ routes, selectedIndex, onSelect, from, to, stations, highlight }: Props) {
  const divRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layersRef = useRef<L.LayerGroup | null>(null)

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

    // 高亮路段（表格点击）：WGS-84 → GCJ-02 显示，粗黄线 + 端点标记
    let highlightCoords: Array<[number, number]> = []
    if (highlight && highlight.length >= 2) {
      highlightCoords = highlight.map(([lng, lat]) => wgs84ToGcj02(lng, lat)).map(([lng, lat]) => [lat, lng] as [number, number])
      const hl = L.polyline(highlightCoords, {
        color: '#ffd700', weight: 9, opacity: 0.95,
      }).addTo(layers)
      hl.bindTooltip('选中路段（' + highlight.length + ' 点）', { sticky: true })
      L.circleMarker(highlightCoords[0], { radius: 6, color: '#fff', weight: 2, fillColor: '#ffd700', fillOpacity: 1 }).addTo(layers).bindTooltip('路段起点')
      L.circleMarker(highlightCoords[highlightCoords.length - 1], { radius: 6, color: '#fff', weight: 2, fillColor: '#ffd700', fillOpacity: 1 }).addTo(layers).bindTooltip('路段终点')
    }

    const selCoords = routes[selectedIndex] ? polylineToCoords(routes[selectedIndex].polyline) : []
    for (const s of stations) {
      const dist = selCoords.length ? pointToPolylineKm(s.lng, s.lat, selCoords) : Infinity
      const near = dist <= 20
      L.circleMarker([s.lat, s.lng], {
        radius: near ? 5 : 2.5, color: '#fff', weight: near ? 1 : 0.5,
        fillColor: near ? (s.useType === 1 ? '#1f77b4' : '#ff8c00') : '#b0b8b5', fillOpacity: near ? 0.95 : 0.5,
      }).addTo(layers).bindTooltip(`${s.name}${near ? '（距线' + dist.toFixed(1) + 'km）' : ''}${s.price ? ' ' + s.price + '元' : ''}`, { direction: 'top' })
    }
    if (highlightCoords.length >= 2) {
      map.fitBounds(L.latLngBounds(highlightCoords).pad(0.25))
    } else if (bounds.length) {
      map.fitBounds(L.latLngBounds(bounds).pad(0.15))
    }
  }, [routes, selectedIndex, from, to, stations, onSelect, highlight])

  return <div ref={divRef} style={{ height: '100%', width: '100%' }} />
}
