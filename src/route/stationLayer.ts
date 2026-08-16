/** 加氢站图层：沿线加氢站搜索（本地计算，不调 API） */
import fs from 'node:fs'
import type { H2Station, NearbyStation } from './types'
import { pointToPolylineDist, round1 } from './parse'

/** 从 GeoJSON 加载加氢站 */
export function loadStations(path: string): H2Station[] {
  const geo = JSON.parse(fs.readFileSync(path, 'utf8')) as {
    features: Array<{
      properties: {
        id: number
        name: string
        price: number | null
        pressure: string
        guns: number | null
        useType: number
      }
      geometry: { coordinates: [number, number] }
    }>
  }
  return geo.features.map((f) => ({
    id: f.properties.id,
    name: f.properties.name,
    lng: f.geometry.coordinates[0],
    lat: f.geometry.coordinates[1],
    price: f.properties.price != null ? Number(f.properties.price) : null,
    pressure: f.properties.pressure || '',
    guns: f.properties.guns != null ? Number(f.properties.guns) : null,
    useType: f.properties.useType ?? 0,
  }))
}

/** polyline 字符串 → [lng, lat][] */
export function polylineToCoords(polyline: string): Array<[number, number]> {
  return polyline
    .split(';')
    .filter(Boolean)
    .map((pt) => {
      const [lng, lat] = pt.split(',').map(Number)
      return [lng, lat] as [number, number]
    })
}

/**
 * 查找路线沿线半径内的加氢站
 * @param polyline 路线坐标字符串
 * @param stations 加氢站列表
 * @param radiusKm 搜索半径（km）
 * @param max 最多返回数量
 */
export function findNearbyStations(
  polyline: string,
  stations: H2Station[],
  radiusKm = 20,
  max = 20,
): NearbyStation[] {
  const coords = polylineToCoords(polyline)
  if (coords.length < 2) return []
  const hits: NearbyStation[] = []
  for (const st of stations) {
    const d = pointToPolylineDist(st.lng, st.lat, coords)
    if (d <= radiusKm * 1000) {
      hits.push({
        name: st.name,
        distanceKm: round1(d / 1000),
        price: st.price,
        pressure: st.pressure,
        guns: st.guns,
        lng: st.lng,
        lat: st.lat,
      })
    }
  }
  return hits.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, max)
}
