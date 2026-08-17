/**
 * DEM（数字高程模型）模块：从公开瓦片源提取海拔 / 坡度，供物理模型坡度阻力计算。
 *
 * 数据源（A1 已验证可行，均无需 Key）：
 * 1. 首选：AWS Open Data "Mapzen Terrain Tiles"（terrarium 编码，SRTM 派生全球高程）
 *    URL: https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png
 *    - z14 在中国中纬度约 76m/像素，瓦片约 30~100KB；z15 约 38m/像素；
 *    - 编码：elevation(m) = (R*256 + G + B/256) - 32768；
 *    - 无鉴权、可自托管/本地缓存，适合批量坡度提取。
 * 2. 备选：opentopodata.org SRTM90m API（免 Key，单请求最多 100 点），用于抽查/兜底。
 *
 * 注意：高德坐标是 GCJ-02，采样前必须先用 gcj02ToWgs84 转 WGS-84（见 coords.ts）。
 *
 * 运行环境：本模块仅在 Node 侧使用（scripts / vite 中间件），不进入浏览器打包。
 */

import { inflateSync } from 'node:zlib'

/** Web Mercator 瓦片坐标（x, y） */
export function tileXY(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z
  const x = Math.floor(((lng + 180) / 360) * n)
  const y = Math.floor(
    ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n,
  )
  return [x, y]
}

/** 一条折线（WGS-84）跨过的去重瓦片集合（用于预取与缓存规划） */
export function uniqueTilesAlong(
  coordsWgs84: Array<[number, number]>,
  z: number,
): Array<[number, number]> {
  const set = new Set<string>()
  const out: Array<[number, number]> = []
  for (const [lng, lat] of coordsWgs84) {
    const [x, y] = tileXY(lng, lat, z)
    const k = x + ',' + y
    if (!set.has(k)) {
      set.add(k)
      out.push([x, y])
    }
  }
  return out
}

/** 解码 8-bit PNG（RGB / RGBA / 灰度），返回原始像素缓冲（terrarium 瓦片为 RGB） */
export function decodePng(bytes: Uint8Array): {
  width: number
  height: number
  channels: number
  data: Uint8Array
} {
  const buf = Buffer.from(bytes)
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG file')
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error('unsupported bit depth: ' + bitDepth)
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : -1
  if (channels < 0) throw new Error('unsupported color type: ' + colorType)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    const row = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= channels ? prev[i - channels] : 0
      let v = raw[rp++]
      if (filter === 1) v = (v + a) & 0xff
      else if (filter === 2) v = (v + b) & 0xff
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        v = (v + pr) & 0xff
      }
      row[i] = v
    }
  }
  return { width, height, channels, data: out }
}

/** terrarium 编码 → 海拔（米） */
export function terrariumElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768
}

/** 在已解码瓦片内采样某经纬度的高程（最近邻；tile 需覆盖该点） */
export function sampleElevationInTile(
  tile: { x: number; y: number; z: number; width: number; height: number; channels: number; data: Uint8Array },
  lng: number,
  lat: number,
): number {
  const n = 2 ** tile.z
  const px = Math.floor(((lng + 180) / 360) * n * 256) - tile.x * 256
  const py =
    Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n * 256) -
    tile.y * 256
  const x = Math.max(0, Math.min(tile.width - 1, px))
  const y = Math.max(0, Math.min(tile.height - 1, py))
  const i = (y * tile.width + x) * tile.channels
  return terrariumElevation(tile.data[i], tile.data[i + 1], tile.data[i + 2])
}

/* ============================ 剖面计算（A2） ============================ */

/** 两点球面距离（米，haversine） */
export function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371000
  const dLat = ((b[1] - a[1]) * Math.PI) / 180
  const dLng = ((b[0] - a[0]) * Math.PI) / 180
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

/** 折线重采样点：沿折线每 stepM 米取一个点（含起点），用于稳定采样海拔/坡度 */
export interface ProfilePoint {
  lng: number
  lat: number
  /** 到段起点的累计里程（米） */
  cumM: number
}

export function resampleCoords(
  coords: Array<[number, number]>,
  stepM = 200,
): ProfilePoint[] {
  if (coords.length === 0) return []
  const cum: number[] = [0]
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversineM(coords[i - 1], coords[i]))
  }
  const total = cum[cum.length - 1]
  const out: ProfilePoint[] = []
  let target = 0
  while (target <= total + 1e-6) {
    let i = 1
    while (i < cum.length && cum[i] < target - 1e-6) i++
    if (i >= cum.length) break
    const segLen = cum[i] - cum[i - 1]
    const t = segLen > 0 ? (target - cum[i - 1]) / segLen : 0
    out.push({
      lng: coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
      lat: coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
      cumM: target,
    })
    target += stepM
  }
  return out
}
