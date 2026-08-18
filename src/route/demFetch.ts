/**
 * DEM 获取与路段高程填充（Node 侧，供 vite 中间件 / scripts 使用）
 *
 * 主源：terrarium 瓦片（免 Key，z14 ≈76m/px）
 *   https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png
 * 兜底：opentopodata SRTM90m API（免 Key，单请求 ≤100 点）
 *
 * 缓存：瓦片写入 data/dem-cache/z_x_y.png（已 gitignore），同一走廊一次下载后复用。
 *
 * —— 路段自适应切分（创新点：行为区 + 坡度带）——
 * 高德按"导航动作"切 step：高速上连续 90km 不拐弯只给 1 段、城区几米也给 1 段，
 * 直接用于氢耗仿真会"平均掉坡度"。本模块在高程填充前做两件事：
 *   ① 行为感知合并：只有"同路 + 无变速事件 + <0.2km"的纯延续碎段才并入前一段，
 *      收费站/路口/匝道/转弯等行为区短段一律保留（短段不再一律合并）；
 *   ② 坡度自适应切分（对所有 ≥1km 的段）：
 *      - 坡度变号（峰/谷）必切 → 每子段只上坡或只下坡；
 *      - 坡度带阈值：滑动窗口平均坡度偏离当前段均值 > ±1.5% → 切（控制段内坡度幅度）；
 *      - 长度上限 10km、巡航段最小 0.5km；
 *      子段继承父段路名/等级/路况/变速行为，重新计算各自坡度/海拔/爬升下降。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MotionBehavior, SegmentData } from './types'
import {
  decodePng, haversineM, resampleCoords, sampleElevationInTile,
  tileXY, type ProfilePoint,
} from './dem'
import { round1, round2 } from './parse'
import { buildIntersectionEvents, isEventBehavior } from './segment'

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
  /** 采样步长（米，默认 200；opentopodata 兜底固定 500） */
  sampleM?: number
  /** 坡度切分参数（覆盖默认值） */
  split?: SplitParams
}

export interface EnrichResult {
  segments: SegmentData[]
  /** 使用的瓦片数（opentopodata 兜底时为 0） */
  tilesUsed: number
  z: number
  source: 'terrarium' | 'opentopodata'
}

/* ===== 路段自适应切分参数（可配置） ===== */
/** 段长上限：超过 10km 必切 */
export const MAX_SEGMENT_KM = 10
/** 巡航段最小长度：小于此长度不再细分（事件段可更短） */
export const MIN_SEGMENT_KM = 0.5
/** 参与地形切分的最小段长：短于此的段（多为行为区/城市短段）不切分 */
export const MIN_SPLIT_KM = 1.0
/** 坡度带阈值（%）：滑动窗口平均坡度偏离当前段均值超过该值 → 切分 */
export const GRADE_BAND_PCT = 1.5
/** 滑动窗口（m）：用于平滑 DEM 噪声、判定"坡度带变化" */
export const GRADE_WINDOW_M = 500
/** 纯延续碎段合并阈值：<0.2km 且同路、无变速事件才并入前段 */
export const MERGE_TINY_KM = 0.2

/** 坡度切分参数（覆盖默认值用） */
export interface SplitParams {
  maxKm?: number
  minKm?: number
  minSplitKm?: number
  bandPct?: number
  windowM?: number
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
/** 段是否携带离散变速事件（收费站/路口/匝道等） */
function hasDiscreteEvents(s: SegmentData): boolean {
  return (s.motionEvents ?? []).some((e) => e.expectedCount > 0)
}

/**
 * ① 行为感知合并：只合并"纯延续碎段"——<0.2km、与前段同路名/同等级/同变速行为、无离散事件。
 * 收费站/路口/匝道等行为区短段、城市起停短段一律保留（短段不再一律合并）。
 */
export function mergeContinuationFragments(segments: SegmentData[]): SegmentData[] {
  const out: SegmentData[] = []
  for (const s of segments) {
    const last = out[out.length - 1]
    const isContinuation =
      last &&
      s.distanceKm < MERGE_TINY_KM &&
      !hasDiscreteEvents(s) &&
      s.roadName === last.roadName &&
      s.roadLevel === last.roadLevel &&
      s.motionBehavior === last.motionBehavior
    if (isContinuation) {
      last.distanceKm = round2(last.distanceKm + s.distanceKm)
      last.durationH = round2(last.durationH + s.durationH)
      last.coordsWgs84 = last.coordsWgs84.concat(s.coordsWgs84)
      if (last.durationH > 0) last.avgSpeedKmh = round1(last.distanceKm / last.durationH)
    } else {
      out.push({ ...s, coordsWgs84: [...s.coordsWgs84] })
    }
  }
  return out
}

/**
 * ② 坡度自适应切分：坡度变号（峰/谷）必切 + 坡度带阈值 + 长度上限。
 * 目标：每子段"内部匀质"——只上坡或只下坡、段内坡度幅度 ≈ bandPct、长度在 min~max。
 * 返回按切分点切开的剖面子集（每个子集为一段）。
 */
export function splitGradeProfile(
  pts: ProfilePoint[],
  elevs: number[],
  o: SplitParams = {},
): ProfileSlice[] {
  const maxKm = o.maxKm ?? MAX_SEGMENT_KM
  const minKm = o.minKm ?? MIN_SEGMENT_KM
  const minSplitKm = o.minSplitKm ?? MIN_SPLIT_KM
  const bandPct = o.bandPct ?? GRADE_BAND_PCT
  const windowM = o.windowM ?? GRADE_WINDOW_M
  const n = pts.length
  if (n < 3) return [rebaseSlice(pts, elevs, 0, n - 1)]
  const totalM = pts[n - 1].cumM
  if (totalM < minSplitKm * 1000) return [rebaseSlice(pts, elevs, 0, n - 1)]

  // 每采样间隔的坡度（%）
  const grade: number[] = new Array(n).fill(0)
  for (let i = 1; i < n; i++) {
    const d = pts[i].cumM - pts[i - 1].cumM
    if (d >= 1 && Number.isFinite(elevs[i]) && Number.isFinite(elevs[i - 1])) {
      grade[i] = ((elevs[i] - elevs[i - 1]) / d) * 100
    }
  }
  // 前向滑动窗口平均坡度（平滑 DEM 噪声）
  const stepM = totalM / (n - 1)
  const winLen = Math.max(2, Math.round(windowM / stepM))
  const winGrade: number[] = new Array(n).fill(0)
  for (let k = 0; k < n; k++) {
    let sum = 0
    let cnt = 0
    const end = Math.min(n, k + winLen)
    for (let j = k; j < end; j++) {
      if (Number.isFinite(grade[j])) {
        sum += grade[j]
        cnt++
      }
    }
    winGrade[k] = cnt ? sum / cnt : 0
  }

  const minIdxStep = Math.ceil((minKm * 1000) / Math.max(stepM, 1))
  const cuts: number[] = []
  let start = 0
  let i = 1
  while (i < n - 1) {
    const lenM = pts[i].cumM - pts[start].cumM
    if (lenM >= minKm * 1000) {
      // 当前候选段 [start, i] 的平均坡度
      let gsum = 0
      let gcnt = 0
      for (let j = start + 1; j <= i; j++) {
        if (Number.isFinite(grade[j])) {
          gsum += grade[j]
          gcnt++
        }
      }
      const gMean = gcnt ? gsum / gcnt : 0
      // ① 长度上限：在最近一段窗口内找 |坡度| 最大处切，保证新段 ≥ minKm
      if (lenM >= maxKm * 1000) {
        const lo = Math.max(start + minIdxStep, i - winLen)
        let best = i
        let bestD = -1
        for (let j = lo; j <= i; j++) {
          if (Number.isFinite(grade[j]) && Math.abs(grade[j]) > bestD) {
            bestD = Math.abs(grade[j])
            best = j
          }
        }
        if (best <= start) best = i
        cuts.push(best)
        start = best
        i = start + 1
        continue
      }
      // ② 坡度带：前方窗口均值偏离当前段均值超过 band → 切（把"新坡度带"开出来）
      if (Math.abs(winGrade[i] - gMean) > bandPct) {
        cuts.push(i)
        start = i
        i = start + 1
        continue
      }
      // ③ 变号（峰/谷）：前方窗口均值符号与当前段均值相反，且都足够陡（滤噪声）
      if (
        gMean !== 0 &&
        winGrade[i] !== 0 &&
        Math.sign(winGrade[i]) !== Math.sign(gMean) &&
        Math.abs(gMean) > 0.3 &&
        Math.abs(winGrade[i]) > 0.3
      ) {
        cuts.push(i)
        start = i
        i = start + 1
        continue
      }
    }
    i++
  }

  // 组装切片
  const idxs = [0, ...cuts, n - 1]
  const slices: ProfileSlice[] = []
  for (let k = 0; k < idxs.length - 1; k++) {
    const a = idxs[k]
    const b = idxs[k + 1]
    if (b > a) slices.push(rebaseSlice(pts, elevs, a, b))
  }
  // 尾部过短（< 0.5×minKm）且坡度接近 → 并入前一片（唯一允许的"合并"）
  if (slices.length > 1) {
    const tailKm = slices[slices.length - 1].pts.length
      ? slices[slices.length - 1].pts[slices[slices.length - 1].pts.length - 1].cumM
      : 0
    if (tailKm < minKm * 500) {
      const a = idxs[idxs.length - 3]
      slices[slices.length - 2] = rebaseSlice(pts, elevs, a, n - 1)
      slices.pop()
    }
  }
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
function finalizeSub(parent: SegmentData, slice: ProfileSlice, sliceIndex = 0): SegmentData {
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
  // 事件段（收费站/匝道/路口/转弯/服务区）：不切分，事件原样保留（只挂首片，防御性）
  // 非事件段（巡航/城市起停）：按本子段里程比例重算红绿灯事件——
  //   父段在 buildSegments 算的事件是整段口径，若地形切分成多片，不能全堆在首片
  const isEventParent = isEventBehavior(parent.motionBehavior)
  const motionEvents = isEventParent
    ? sliceIndex === 0 ? (parent.motionEvents ?? []) : []
    : buildIntersectionEvents(distanceKm, parent.roadLevel, parent.trafficStatus)
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
    motionBehavior: parent.motionBehavior,
    motionEvents,
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

/** 是否参与坡度地形切分：只有巡航/城市起停段切分；
 * 收费站/匝道/路口/转弯/服务区等行为事件段保持整段——事件是"点状行为"，拆散会
 * 造成同类事件段又密又碎、且事件概率被分散到多个子段。 */
export function shouldSplitByGrade(behavior: MotionBehavior): boolean {
  return !isEventBehavior(behavior)
}

/** 剖面子集列表 → 子段（继承父段行为字段；离散事件只挂到首个子段，避免重复计数） */
function slicesToSubs(parent: SegmentData, slices: ProfileSlice[]): SegmentData[] {
  return slices.map((sl, k) => finalizeSub(parent, sl, k))
}

/** terrarium 路径：行为感知合并 → 采样剖面 → 坡度自适应切分 → 生成子段 */
function enrichWithTiles(
  segments: SegmentData[],
  tiles: Map<string, DemTile>,
  z: number,
  o: DemOptions = {},
): SegmentData[] {
  const sampleM = o.sampleM ?? 200
  const merged = mergeContinuationFragments(segments)
  const out: SegmentData[] = []
  for (const s of merged) {
    let pts = resampleCoords(s.coordsWgs84, sampleM)
    if (pts.length < 2 && s.coordsWgs84.length >= 2) {
      // 极短段（< 采样步长）：强制取首尾两点，保证不丢段
      const first = s.coordsWgs84[0]
      const last = s.coordsWgs84[s.coordsWgs84.length - 1]
      pts = [
        { lng: first[0], lat: first[1], cumM: 0 },
        { lng: last[0], lat: last[1], cumM: haversineM(first, last) },
      ]
    }
    if (pts.length < 2) continue
    const elevs = pts.map((p) => {
      const [tx, ty] = tileXY(p.lng, p.lat, z)
      const tile = tiles.get(tx + ',' + ty)
      return tile ? sampleElevationInTile(tile, p.lng, p.lat) : NaN
    })
    const slices = shouldSplitByGrade(s.motionBehavior) ? splitGradeProfile(pts, elevs, o.split) : [{ pts, elevs }]
    const subs = slicesToSubs(s, slices)
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
    const refined = enrichWithTiles(segments, tiles, z, opts)
    return { segments: refined, tilesUsed: tiles.size, z, source: 'terrarium' }
  } catch (e) {
    console.warn('[dem] terrarium 失败，改用 opentopodata 兜底:', (e as Error).message)
    return enrichViaOpentopodata(segments)
  }
}

/** opentopodata 兜底：500m 重采样 + 同样的切分逻辑 */
async function enrichViaOpentopodata(segments: SegmentData[]): Promise<EnrichResult> {
  const merged = mergeContinuationFragments(segments)
  const perSeg: ProfilePoint[][] = merged.map((s) => resampleCoords(s.coordsWgs84, 500))
  // 极短段强制取首尾两点
  for (let si = 0; si < merged.length; si++) {
    if (perSeg[si].length < 2 && merged[si].coordsWgs84.length >= 2) {
      const first = merged[si].coordsWgs84[0]
      const last = merged[si].coordsWgs84[merged[si].coordsWgs84.length - 1]
      perSeg[si] = [
        { lng: first[0], lat: first[1], cumM: 0 },
        { lng: last[0], lat: last[1], cumM: haversineM(first, last) },
      ]
    }
  }
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
    const slices = shouldSplitByGrade(s.motionBehavior) ? splitGradeProfile(pts, segElevs) : [{ pts, elevs: segElevs }]
    const subs = slicesToSubs(s, slices)
    out.push(...scaleSubs(s, subs))
  }
  out.forEach((x, i) => { x.index = i })
  return { segments: out, tilesUsed: 0, z: 0, source: 'opentopodata' }
}
