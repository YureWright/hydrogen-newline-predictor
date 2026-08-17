/**
 * 坐标系工具：GCJ-02（高德/火星坐标）↔ WGS-84（GPS/国际标准）
 *
 * 背景：高德返回的路线坐标是 GCJ-02（中国国测局加密坐标），与真实经纬度偏差约
 * 100~700m；而 SRTM DEM、OSM、OpenWeather 等外部数据均为 WGS-84。
 * 策略：地图显示保留 GCJ-02（与高德瓦片一致）；做数据匹配（DEM 坡度 / 天气采样）
 * 前先逆转换到 WGS-84。转换误差 <10m，对 30m 分辨率 DEM 可忽略。
 *
 * 算法来源：业界通用的 GCJ-02 偏移算法（coordtransform 同款，MIT 协议），
 * 已与公开在线工具交叉验证。
 */

const a = 6378245.0
const ee = 0.00669342162296594323

/** 是否在中国境外（境外无偏移，直接透传） */
export function outOfChina(lng: number, lat: number): boolean {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55)
}

function transformLat(x: number, y: number): number {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320.0 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0
  return ret
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0
  return ret
}

/** WGS-84 → GCJ-02 */
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat]
  const dLat = transformLat(lng - 105.0, lat - 35.0)
  const dLng = transformLng(lng - 105.0, lat - 35.0)
  const radLat = (lat / 180.0) * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - ee * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  const ddLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI)
  const ddLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI)
  return [lng + ddLng, lat + ddLat]
}

/** GCJ-02 → WGS-84（高德坐标转标准坐标，用于与 DEM / 天气等外部数据匹配） */
export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat]
  const [gLng, gLat] = wgs84ToGcj02(lng, lat)
  return [lng * 2 - gLng, lat * 2 - gLat]
}

/** 高德 polyline 字符串 "lng,lat;lng,lat;..." → [lng,lat][]（保持原始坐标系 GCJ-02） */
export function decodePolyline(polyline: string): Array<[number, number]> {
  if (!polyline) return []
  return polyline
    .split(';')
    .filter(Boolean)
    .map((pt) => {
      const [lng, lat] = pt.split(',').map(Number)
      return [lng, lat] as [number, number]
    })
}
