/**
 * DEM 获取与路段高程填充（Node 侧，供 vite 中间件 / scripts 使用）
 *
 * 主源：terrarium 瓦片（免 Key，z14 ≈76m/px）
 *   https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png
 * 兜底：opentopodata SRTM90m API（免 Key，单请求 ≤100 点）
 *
 * 缓存：瓦片写入 data/dem-cache/z_x_y.png（已 gitignore），同一走廊一次下载后复用。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SegmentData } from './types'
import {
  decodePng, resampleCoords, sampleElevationInTile,
  tileXY, type ProfilePoint,
} from './dem'
import { round2 } from './parse'

export interface DemTile {
  x: number
  y: number
  z: number
  width: number
  height: number
  channels: number
  data: Uint8Array
}

export interface DemOptions {
  /** 瓦片级别（默认 14） */
  z?: number
  /** 瓦片缓存目录（默认 data/dem-cache） */
  cacheDir?: string
  /** 并发下载数（默认 6） */
  concurrency?: number
  /** terrarium 瓦片 URL 模板（{z}/{x}/{y}） */
  terrariumBase?: string
}

export interface EnrichResult {
  segments: SegmentData[]
  /** 使用的瓦片数（opentopodata 兜底时为 0） */
  tilesUsed: number
  z: number
  source: 'terrarium' | 'opentopodata'
}

const DEFAULT_TERRARIUM = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium'

/** 内存瓦片缓存（避免同一进程内重复解码 PNG；超过上限时清空） */
const tileMemoryCache = new Map<string, DemTile>()
const MEMORY_CACHE_LIMIT = 1200
function cachePut(k: string, tile: DemTile): void {
  if (tileMemoryCache.size >= MEMORY_CACHE_LIMIT) tileMemoryCache.clear()
  tileMemoryCache.set(k, tile)
}

async function fetchBytes(url: string, timeoutMs = 20000): Promise<Buffer> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url)
  return Buffer.from(await r.arrayBuffer())
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 带重试的下载（S3 偶发超时，重试 2 次） */
async function fetchBytesWithRetry(url: string, timeoutMs = 20000, retries = 2): Promise<Buffer> {
  let lastErr: Error | null = null
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchBytes(url, timeoutMs)
    } catch (e: any) {
      lastErr = e
      await sleep(400 * (i + 1))
    }
  }
  throw lastErr as Error
}

/** 收集所有路段坐标覆盖的瓦片 key（x,y） */
function collectTileKeys(segments: SegmentData[], z: number): Map<string, [number, number]> {
  const map = new Map<string, [number, number]>()
  for (const s of segments) {
    for (const [lng, lat] of s.coordsWgs84) {
      const [x, y] = tileXY(lng, lat, z)
      const k = x + ',' + y
      if (!map.has(k)) map.set(k, [x, y])
    }
  }
  return map
}

/** 并发下载（带磁盘缓存）并解码瓦片 */
export async function loadDemTiles(
  segments: SegmentData[],
  opts: DemOptions = {},
): Promise<Map<string, DemTile>> {
  const z = opts.z ?? 14
  const cacheDir = opts.cacheDir ?? join(process.cwd(), 'data', 'dem-cache')
  const concurrency = opts.concurrency ?? 6
  const terrariumBase = (opts.terrariumBase ?? DEFAULT_TERRARIUM).replace(/\/$/, '')
  const needed = collectTileKeys(segments, z)
  mkdirSync(cacheDir, { recursive: true })
  const tiles = new Map<string, DemTile>()
  const keys = [...needed.keys()]

  let next = 0
  let failures = 0
  async function worker() {
    while (next < keys.length) {
      const k = keys[next++]
      const [x, y] = needed.get(k)!
      const cached = tileMemoryCache.get(z + '_' + k)
      if (cached) {
        tiles.set(k, cached)
        continue
      }
      const file = join(cacheDir, z + '_' + x + '_' + y + '.png')
      let bytes: Buffer
      if (existsSync(file)) {
        bytes = readFileSync(file)
      } else {
        try {
          bytes = await fetchBytesWithRetry(terrariumBase + '/' + z + '/' + x + '/' + y + '.png')
          try { writeFileSync(file, bytes) } catch { /* 缓存写入失败不影响主流程 */ }
        } catch {
          failures++ // 单张失败跳过，不中断整批；对应点高程留空
          continue
        }
      }
      const png = decodePng(bytes)
      const tile = { x, y, z, width: png.width, height: png.height, channels: png.channels, data: png.data }
      cachePut(z + '_' + k, tile)
      tiles.set(k, tile)
    }
  }
  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(concurrency, keys.length); i++) workers.push(worker())
  await Promise.all(workers)
  if (failures > 0) console.warn('[dem] 瓦片下载失败 ' + failures + '/' + keys.length + ' 张（已跳过，对应路段高程留空）')
  return tiles
}

/** 用已解码瓦片填充单段：海拔均值 + 距离加权坡度 + 爬升/下降 + 剖面 */
function enrichOneWithTiles(s: SegmentData, tiles: Map<string, DemTile>, z: number): void {
  const pts = resampleCoords(s.coordsWgs84, 200)
  if (pts.length < 2) return
  const elevs = pts.map((p) => {
    const [tx, ty] = tileXY(p.lng, p.lat, z)
    const tile = tiles.get(tx + ',' + ty)
    return tile ? sampleElevationInTile(tile, p.lng, p.lat) : NaN
  })
  const valid = elevs.filter((v) => Number.isFinite(v))
  if (valid.length < 2) return
  s.elevationM = Math.round(valid.reduce((a, b) => a + b, 0) / valid.length)
  let gradeW = 0
  let distW = 0
  let gain = 0
  let loss = 0
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i].cumM - pts[i - 1].cumM
    if (d < 1 || !Number.isFinite(elevs[i]) || !Number.isFinite(elevs[i - 1])) continue
    const dh = elevs[i] - elevs[i - 1]
    gradeW += (dh / d) * 100 * d
    distW += d
    if (dh > 0) gain += dh
    else loss += -dh
  }
  s.gradePercent = distW > 0 ? round2(gradeW / distW) : 0
  s.elevationGainM = Math.round(gain)
  s.elevationLossM = Math.round(loss)
  s.profile = {
    distKm: pts.map((p) => round2(p.cumM / 1000)),
    elevM: elevs.map((v) => (Number.isFinite(v) ? Math.round(v) : 0)),
  }
}

/** 主入口：terrarium 优先，失败时 opentopodata 兜底 */
export async function enrichSegmentsWithDem(
  segments: SegmentData[],
  opts: DemOptions = {},
): Promise<EnrichResult> {
  const z = opts.z ?? 14
  try {
    const tiles = await loadDemTiles(segments, opts)
    for (const s of segments) enrichOneWithTiles(s, tiles, z)
    return { segments, tilesUsed: tiles.size, z, source: 'terrarium' }
  } catch (e) {
    console.warn('[dem] terrarium 失败，改用 opentopodata 兜底:', (e as Error).message)
    return enrichViaOpentopodata(segments)
  }
}

/** opentopodata 兜底：按段 500m 重采样，批量请求（≤90 点/次） */
async function enrichViaOpentopodata(segments: SegmentData[]): Promise<EnrichResult> {
  const perSeg: ProfilePoint[][] = segments.map((s) => resampleCoords(s.coordsWgs84, 500))
  const all = perSeg.flat()
  const elevs: number[] = []
  for (let i = 0; i < all.length; i += 90) {
    const chunk = all.slice(i, i + 90)
    const locs = chunk.map((p) => p.lat + ',' + p.lng).join('|')
    const r = await fetch('https://api.opentopodata.org/v1/srtm90m?locations=' + locs, {
      signal: AbortSignal.timeout(30000),
    })
    const j: any = await r.json()
    if (!j.results) throw new Error('opentopodata error: ' + JSON.stringify(j).slice(0, 200))
    elevs.push(...j.results.map((x: any) => (x.elevation == null ? NaN : x.elevation)))
    await sleep(1200) // 免费 API 限流：每秒 ≤1 请求
  }
  let k = 0
  for (let si = 0; si < segments.length; si++) {
    const s = segments[si]
    const pts = perSeg[si]
    if (pts.length < 2) continue
    const segElevs: number[] = []
    for (let i = 0; i < pts.length; i++) segElevs.push(elevs[k++])
    const valid = segElevs.filter((v) => Number.isFinite(v))
    if (valid.length < 2) continue
    s.elevationM = Math.round(valid.reduce((a, b) => a + b, 0) / valid.length)
    let gradeW = 0
    let distW = 0
    let gain = 0
    let loss = 0
    for (let i = 1; i < pts.length; i++) {
      const d = pts[i].cumM - pts[i - 1].cumM
      if (d < 1 || !Number.isFinite(segElevs[i]) || !Number.isFinite(segElevs[i - 1])) continue
      const dh = segElevs[i] - segElevs[i - 1]
      gradeW += (dh / d) * 100 * d
      distW += d
      if (dh > 0) gain += dh
      else loss += -dh
    }
    s.gradePercent = distW > 0 ? round2(gradeW / distW) : 0
    s.elevationGainM = Math.round(gain)
    s.elevationLossM = Math.round(loss)
    s.profile = {
      distKm: pts.map((p) => round2(p.cumM / 1000)),
      elevM: segElevs.map((v) => (Number.isFinite(v) ? Math.round(v) : 0)),
    }
  }
  return { segments, tilesUsed: 0, z: 0, source: 'opentopodata' }
}
