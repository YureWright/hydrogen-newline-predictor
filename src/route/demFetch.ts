/**
 * DEM 获取与路段高程填充（Node 侧，供 vite 中间件 / scripts 使用）
 *
 * 主源：terrarium 瓦片（免 Key，z14 ≈76m/px）
 *   https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png
 * 兜底：opentopodata SRTM90m API（免 Key，单请求 ≤100 点）
 *
 * 缓存：瓦片写入 data/dem-cache/z_x_y.png（已 gitignore），同一走廊一次下载后复用。
 *
 * —— 路段自适应细分（创新点）——
 * 高德按"导航动作"切 step：高速上连续 90km 不拐弯只给 1 段、城区几米也给 1 段，
 * 直接用于氢耗仿真会"平均掉坡度"。本模块在高程填充前做两件事：
 *   ① 合并碎段：<0.3km 的段并入前一段（清掉起终点几米的垃圾行）；
 *   ② 细分长段：>10km 的段沿 DEM 高程剖面在"坡度变号点（峰/谷）"切开，
 *      每子段 2~10km，继承父段的路名/等级/路况，重新计算各自坡度/海拔/爬升下降。
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

/** 进度信息（供前端进度条） */
export interface DemProgress {
  phase: 'route' | 'dem' | 'compute'
  done: number
  total: number
  cached: number
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
  /** 进度回调（下载瓦片阶段逐张上报） */
  onProgress?: (p: DemProgress) => void
}

export interface EnrichResult {
  segments: SegmentData[]
  /** 使用的瓦片数（opentopodata 兜底时为 0） */
  tilesUsed: number
  z: number
  source: 'terrarium' | 'opentopodata'
}

/* ===== 路段自适应细分参数 ===== */
/** 长段细分阈值：超过 10km 就按坡度变号切开 */
export const MAX_SEGMENT_KM = 10
/** 子段最小长度：避免切出过碎的小段 */
export const MIN_SUB_KM = 2
/** 碎段合并阈值：小于 0.3km 并入前一段 */
export const MERGE_TINY_KM = 0.3

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
  let cachedCount = 0
  for (const k of keys) {
    const [x, y] = needed.get(k)!
    if (existsSync(join(cacheDir, z + '_' + x + '_' + y + '.png'))) cachedCount++
  }
  opts.onProgress?.({ phase: 'dem', done: 0, total: keys.length, cached: cachedCount })

  let next = 0
  let failures = 0
  let doneCount = 0
  let downloaded = 0
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
        downloaded++
      }
      const png = decodePng(bytes)
      const tile = { x, y, z, width: png.width, height: png.height, channels: png.channels, data: png.data }
      cachePut(z + '_' + k, tile)
      tiles.set(k, tile)
      doneCount++
      opts.onProgress?.({ phase: 'dem', done: doneCount, total: keys.length, cached: cachedCount + downloaded })
    }
  }
  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(concurrency, keys.length); i++) workers.push(worker())
  await Promise.all(workers)
  if (failures > 0) console.warn('[dem] 瓦片下载失败 ' + failures + '/' + keys.length + ' 张（已跳过，对应路段高程留空）')
  return tiles
}

/* ================= 路段自适应细分（合并碎段 + 坡度变号切长段） ================= */

/** 一段剖面子集（pts 的 cumM 已相对子段起点归零） */
interface ProfileSlice {
  pts: ProfilePoint[]
  elevs: number[]
}

/** ① 合并碎段：<MERGE_TINY_KM 的段并入前一段（首段无法并入则保留） */
function mergeTinySegments(segments: SegmentData[]): SegmentData[] {
  const out: SegmentData[] = []
  for (const s of segments) {
    const last = out[out.length - 1]
    if (s.distanceKm < MERGE_TINY_KM && last) {
      last.distanceKm = round2(last.distanceKm + s.distanceKm)
      last.durationH = round2(last.durationH + s.durationH)
      last.coordsWgs84 = last.coordsWgs84.concat(s.coordsWgs84)
      last.avgSpeedKmh = last.durationH > 0 ? round1v(last.distanceKm / last.durationH) : last.avgSpeedKmh
    } else {
      out.push({ ...s, coordsWgs84: [...s.coordsWgs84] })
    }
  }
  return out
}

function round1v(n: number): number {
  return Math.round(n * 10) / 10
}

/** ② 长段按"坡度变号点"切开：子段长度控制在 MIN_SUB_KM~MAX_SEGMENT_KM */
function splitLongProfile(pts: ProfilePoint[], elevs: number[]): ProfileSlice[] {
  const maxM = MAX_SEGMENT_KM * 1000
  const minM = MIN_SUB_KM * 1000
  const slices: ProfileSlice[] = []
  let start = 0
  let lastSign = 0
  let i = 1
  while (i < pts.length) {
    const d = pts[i].cumM - pts[start].cumM
    if (d >= maxM) {
      slices.push(rebaseSlice(pts, elevs, start, i))
      start = i
      lastSign = 0
    } else if (d >= minM) {
      const dh = elevs[i] - elevs[i - 1]
      const sign = dh > 0 ? 1 : dh < 0 ? -1 : 0
      if (sign !== 0) {
        if (lastSign !== 0 && sign !== lastSign) {
          // 坡度变号（上坡→下坡 或 下坡→上坡，即山峰/山谷）→ 在此切开
          slices.push(rebaseSlice(pts, elevs, start, i))
          start = i
          lastSign = 0
        } else {
          lastSign = sign
        }
      }
    }
    i++
  }
  if (start < pts.length - 1) slices.push(rebaseSlice(pts, elevs, start, pts.length - 1))
  return slices
}

function rebaseSlice(pts: ProfilePoint[], elevs: number[], a: number, b: number): ProfileSlice {
  const base = pts[a].cumM
  return {
    pts: pts.slice(a, b + 1).map((p) => ({ lng: p.lng, lat: p.lat, cumM: p.cumM - base })),
    elevs: elevs.slice(a, b + 1),
  }
}

/** ③ 由父段 + 剖面子集生成一个子段（含坡度/海拔/爬升下降/剖面） */
function finalizeSub(parent: SegmentData, slice: ProfileSlice): SegmentData {
  const { pts, elevs } = slice
  const totalM = pts.length ? pts[pts.length - 1].cumM : 0
  const valid = elevs.filter((v) => Number.isFinite(v))
  const elevationM = valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : null
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
  const distanceKm = round2(totalM / 1000)
  const avgSpeedKmh = parent.avgSpeedKmh || 50
  return {
    index: 0, // 最后统一重排
    roadName: parent.roadName,
    roadLevel: parent.roadLevel,
    distanceKm,
    avgSpeedKmh: parent.avgSpeedKmh,
    gradePercent: distW > 0 ? round2(gradeW / distW) : 0,
    elevationM,
    trafficStatus: parent.trafficStatus,
    stopDensity: parent.stopDensity,
    temperatureC: parent.temperatureC,
    coordsWgs84: pts.map((p) => [p.lng, p.lat] as [number, number]),
    durationH: round2(distanceKm / (avgSpeedKmh || 1)),
    elevationGainM: Math.round(gain),
    elevationLossM: Math.round(loss),
    profile: {
      distKm: pts.map((p) => round2(p.cumM / 1000)),
      elevM: elevs.map((v) => (Number.isFinite(v) ? Math.round(v) : 0)),
    },
  }
}


/** 里程校正：子段几何合计与父段 step 里程有 ~1% 偏差，按比例缩放保持一致 */
function scaleSubs(parent: SegmentData, subs: SegmentData[]): SegmentData[] {
  const raw = subs.reduce((a, s) => a + s.distanceKm, 0)
  if (raw <= 0 || Math.abs(raw - parent.distanceKm) < 0.05) return subs
  const f = parent.distanceKm / raw
  return subs.map((s) => ({
    ...s,
    distanceKm: round2(s.distanceKm * f),
    durationH: round2(s.durationH * f),
    profile: s.profile
      ? { distKm: s.profile.distKm.map((d) => round2(d * f)), elevM: s.profile.elevM }
      : undefined,
  }))
}

/** terrarium 路径：合并碎段 → 采样剖面 → 细分长段 → 生成子段 */
function enrichWithTiles(segments: SegmentData[], tiles: Map<string, DemTile>, z: number): SegmentData[] {
  const merged = mergeTinySegments(segments)
  const out: SegmentData[] = []
  for (const s of merged) {
    const pts = resampleCoords(s.coordsWgs84, 200)
    if (pts.length < 2) continue
    const elevs = pts.map((p) => {
      const [tx, ty] = tileXY(p.lng, p.lat, z)
      const tile = tiles.get(tx + ',' + ty)
      return tile ? sampleElevationInTile(tile, p.lng, p.lat) : NaN
    })
    const slices = s.distanceKm > MAX_SEGMENT_KM ? splitLongProfile(pts, elevs) : [{ pts, elevs }]
    const subs = slices.map((sl) => finalizeSub(s, sl))
    out.push(...scaleSubs(s, subs))
  }
  out.forEach((x, i) => { x.index = i })
  return out
}

/** 主入口：terrarium 优先，失败时 opentopodata 兜底 */
export async function enrichSegmentsWithDem(
  segments: SegmentData[],
  opts: DemOptions = {},
): Promise<EnrichResult> {
  const z = opts.z ?? 14
  try {
    const tiles = await loadDemTiles(segments, opts)
    opts.onProgress?.({ phase: 'compute', done: 1, total: 1, cached: tiles.size })
    const refined = enrichWithTiles(segments, tiles, z)
    return { segments: refined, tilesUsed: tiles.size, z, source: 'terrarium' }
  } catch (e) {
    console.warn('[dem] terrarium 失败，改用 opentopodata 兜底:', (e as Error).message)
    return enrichViaOpentopodata(segments)
  }
}

/** opentopodata 兜底：500m 重采样 + 同样的细分逻辑 */
async function enrichViaOpentopodata(segments: SegmentData[]): Promise<EnrichResult> {
  const merged = mergeTinySegments(segments)
  const perSeg: ProfilePoint[][] = merged.map((s) => resampleCoords(s.coordsWgs84, 500))
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
  const out: SegmentData[] = []
  let k = 0
  for (let si = 0; si < merged.length; si++) {
    const s = merged[si]
    const pts = perSeg[si]
    if (pts.length < 2) continue
    const segElevs: number[] = []
    for (let i = 0; i < pts.length; i++) segElevs.push(elevs[k++])
    const slices = s.distanceKm > MAX_SEGMENT_KM ? splitLongProfile(pts, segElevs) : [{ pts, elevs: segElevs }]
    const subs = slices.map((sl) => finalizeSub(s, sl))
    out.push(...scaleSubs(s, subs))
  }
  out.forEach((x, i) => { x.index = i })
  return { segments: out, tilesUsed: 0, z: 0, source: 'opentopodata' }
}
