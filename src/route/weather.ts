/**
 * 天气/环境数据模块（Node 侧）：按"位置 + 时刻"匹配沿线温度 / 风速风向 / 湿度 / 降水
 *
 * 数据源（按优先级，均可选）：
 *   1. 和风天气 QWeather（推荐主源）：个人免费版 1000 次/天，逐小时预报 24h（一次调用返回 24 条小时数据），
 *      location 传 "经度,纬度"，**中国大陆要求 GCJ-02** —— 与高德路线坐标零转换对齐；
 *      字段：温度 / 风速(km/h) / 风向(角度+中文) / 湿度 / 降水量
 *   2. 高德天气（兜底，复用 AMAP_KEY，无需新 key）：免费 30 万次/天，实时 + 未来 4 天日预报，
 *      无逐小时 → 时间匹配到"日"粒度；坐标系 GCJ-02 原生。
 *   3. OpenWeatherMap（可选，需 OPENWEATHER_KEY）：48h 逐小时，但 WGS-84 → 需 gcj02ToWgs84 转换。
 *
 * 时间匹配：用户设定出发时间 → 每段到达时刻 = 出发 + 累计时长（取段中点时刻）；
 *   QWeather 24h 预报按"到达时刻所在小时"匹配；行程超 24h 部分回退高德日预报。
 *
 * 坐标对齐：SegmentData.coordsWgs84 存 WGS-84（供 DEM/OSM），天气查询前转回 GCJ-02
 *   （wgs84ToGcj02）传给 QWeather/高德 —— 以高德坐标系为主；OpenWeather 用 WGS-84。
 *
 * 风速阈值：windThresholdKmh（默认 10.8 km/h ≈ 3 m/s），>= 阈值 → windAffects=true
 *   （物理模型据此决定是否计风阻）；风速/风向总是尽力抓取（与温度同一次响应，不额外消耗调用）。
 *
 * 调用优化与缓存：按 0.05° 网格（≈5km）聚类位置去重，每个网格一次 24h 调用；
 *   结果磁盘缓存 data/weather-cache，同一路线二次运行秒回。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SegmentData } from './types'
import { gcj02ToWgs84, wgs84ToGcj02 } from './coords'

export interface WeatherSample {
  temperatureC: number | null
  windSpeedKmh: number | null
  windDirDeg: number | null
  windDirText: string
  humidityPct: number | null
  precipMm: number | null
  weatherText: string
  source: 'qweather' | 'amap' | 'openweather'
  /** 预报时刻：QWeather/OpenWeather 逐小时 ISO；高德日预报 "YYYY-MM-DD"；高德实时 "now" */
  time: string
}

export interface WeatherOptions {
  /** 出发时间（可被 Date 解析的字符串）；缺省=当前时间 */
  departureTime?: string
  /** 天气结果缓存目录（默认 data/weather-cache） */
  cacheDir?: string
  /** 风速阈值 km/h（默认 10.8）：>= 阈值 → windAffects=true */
  windThresholdKmh?: number
  /** 强制指定主源（测试用） */
  forceProvider?: "qweather" | "amap" | "openweather" | null
  shouldCancel?: () => boolean
  onProgress?: (p: { phase: 'weather'; done: number; total: number }) => void
  useCache?: boolean
}

export interface WeatherResult {
  segments: SegmentData[]
  sampled: number
  bySource: Record<string, number>
  queries: number
  provider: string
  /** 风速 >= 阈值的段数（windAffects=true） */
  windySegments: number
}

export function getWeatherConfig() {
  return {
    qweatherKey: process.env.QWEATHER_KEY || '',
    // 专属 API Host（Console V4 必需）：控制台 → 设置 → API Host，形如 abc1234xyz.def.qweatherapi.com；
    // 未配置时回退旧共享域名 devapi.qweather.com（2026 年起逐步停用）
    qweatherHost: process.env.QWEATHER_HOST || '',
    amapKey: process.env.AMAP_KEY || '',
    openweatherKey: process.env.OPENWEATHER_KEY || '',
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 时刻 → 小时桶（本地时区，取整到小时） */
export function hourKey(t: Date): number {
  return Math.floor(t.getTime() / 3600000)
}

/** 本地日期键 YYYY-MM-DD（高德/和风预报日期均为本地时间，不能用 UTC 的 toISOString） */
export function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return y + "-" + m + "-" + dd
}

/** 0.05° 网格键（≈5km），用于位置聚类去重（GCJ-02 坐标） */
export function gridKey(lng: number, lat: number): string {
  return Math.round(lng * 20) + "," + Math.round(lat * 20)
}

export function gridCenter(key: string): [number, number] {
  const [x, y] = key.split(",").map(Number)
  return [x / 20, y / 20]
}

/* ============================ 数据源抓取 ============================ */

async function fetchJson(url: string, timeoutMs: number): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url.slice(0, 90))
  return r.json()
}

/** QWeather 逐小时 24h（GCJ-02，中国大陆）→ Map<hourKey, WeatherSample> */
async function fetchQweatherHourly(lng: number, lat: number, key: string, host: string): Promise<Map<number, WeatherSample>> {
  // 专属 API Host 优先；未配置回退旧共享域名
  const base = host ? 'https://' + host.replace(/^https?:\/\//, '') : 'https://devapi.qweather.com'
  const url = base + '/v7/weather/24h?location=' + lng.toFixed(6) + ',' + lat.toFixed(6) + '&key=' + encodeURIComponent(key)
  const j = await fetchJson(url, 15000)
  if (j.code !== "200" || !Array.isArray(j.hourly)) throw new Error("QWeather code=" + (j.code || "?") + " " + (j.message || ""))
  const out = new Map<number, WeatherSample>()
  for (const h of j.hourly) {
    const d = new Date(h.fxTime || "")
    if (Number.isNaN(d.getTime())) continue
    out.set(hourKey(d), {
      temperatureC: h.temp != null ? Number(h.temp) : null,
      windSpeedKmh: h.windSpeed != null ? Number(h.windSpeed) : null,
      windDirDeg: h.wind360 != null ? Number(h.wind360) : null,
      windDirText: h.windDir || "",
      humidityPct: h.humidity != null ? Number(h.humidity) : null,
      precipMm: h.precip != null ? Number(h.precip) : null,
      weatherText: h.text || "",
      source: 'qweather',
      time: h.fxTime || "",
    })
  }
  return out
}

/** 高德天气（GCJ-02）：实时 now + 4 天日预报 → { now, byDate } */
async function fetchAmapDaily(lng: number, lat: number, key: string): Promise<{ now: WeatherSample | null; byDate: Map<string, WeatherSample> }> {
  // 高德天气 city 只认 adcode/城市名，不认经纬度 → 先逆地理编码 regeo 拿 adcode
  const regeoUrl = 'https://restapi.amap.com/v3/geocode/regeo?location=' + lng.toFixed(6) + ',' + lat.toFixed(6) + '&key=' + encodeURIComponent(key)
  const rg = await fetchJson(regeoUrl, 15000)
  const adcode = rg && rg.regeocode && rg.regeocode.addressComponent && rg.regeocode.addressComponent.adcode
  if (!adcode) throw new Error('高德逆地理编码无 adcode: ' + JSON.stringify(rg).slice(0, 160))
  const url = 'https://restapi.amap.com/v3/weather/weatherInfo?key=' + encodeURIComponent(key) + '&city=' + encodeURIComponent(String(adcode)) + '&extensions=all'
  const j = await fetchJson(url, 15000)
  // 注意：extensions=all 只返回 forecasts（4 天日预报），lives 实时字段在 extensions=base 才有，因此这里不要求 lives
  if (j.status !== "1" || !Array.isArray(j.forecasts)) throw new Error("高德天气 error: " + (j.info || JSON.stringify(j).slice(0, 160)))
  const now = j.lives && j.lives[0]
  const nowSample: WeatherSample | null = now ? {
    temperatureC: now.temperature != null ? Number(now.temperature) : null,
    windSpeedKmh: null,
    windDirDeg: null,
    windDirText: now.winddirection || "",
    humidityPct: now.humidity != null ? Number(now.humidity) : null,
    precipMm: null,
    weatherText: now.weather || "",
    source: 'amap',
    time: "now",
  } : null
  const byDate = new Map<string, WeatherSample>()
  const fc = j.forecasts && j.forecasts[0]
  if (fc && Array.isArray(fc.casts)) {
    for (const c of fc.casts) {
      const d = c.date || ""
      if (!d) continue
      const dayT = c.daytemp != null ? Number(c.daytemp) : NaN
      const nightT = c.nighttemp != null ? Number(c.nighttemp) : NaN
      const temp = Number.isFinite(dayT) && Number.isFinite(nightT) ? Math.round(((dayT + nightT) / 2) * 10) / 10 : (Number.isFinite(dayT) ? dayT : null)
      byDate.set(d, {
        temperatureC: temp,
        windSpeedKmh: null,
        windDirDeg: null,
        windDirText: c.daywind || "",
        humidityPct: c.dayhumidity != null ? Number(c.dayhumidity) : null,
        precipMm: c.dayprecip != null ? Number(c.dayprecip) : null,
        weatherText: (c.dayweather || "") + "/" + (c.nightweather || ""),
        source: 'amap',
        time: d,
      })
    }
  }
  return { now: nowSample, byDate }
}

/** OpenWeather One Call 3.0（WGS-84）逐小时 48h → Map<hourKey, WeatherSample> */
async function fetchOpenweatherHourly(lng: number, lat: number, key: string): Promise<Map<number, WeatherSample>> {
  const url = 'https://api.openweathermap.org/data/3.0/onecall?lat=' + lat.toFixed(6) + '&lon=' + lng.toFixed(6) + '&exclude=current,minutely,daily,alerts&units=metric&appid=' + encodeURIComponent(key)
  const j = await fetchJson(url, 15000)
  if (!Array.isArray(j.hourly)) throw new Error("OpenWeather error")
  const out = new Map<number, WeatherSample>()
  for (const h of j.hourly) {
    const hk = Math.floor((h.dt || 0) / 3600)
    out.set(hk, {
      temperatureC: h.temp != null ? Number(h.temp) : null,
      windSpeedKmh: h.wind_speed != null ? Math.round(Number(h.wind_speed) * 3.6 * 10) / 10 : null,
      windDirDeg: h.wind_deg != null ? Number(h.wind_deg) : null,
      windDirText: "",
      humidityPct: h.humidity != null ? Number(h.humidity) : null,
      precipMm: (h.rain && h.rain["1h"] != null) ? Number(h.rain["1h"]) : 0,
      weatherText: (h.weather && h.weather[0] && h.weather[0].description) || "",
      source: 'openweather',
      time: new Date((h.dt || 0) * 1000).toISOString(),
    })
  }
  return out
}

/* ============================ 缓存 ============================ */

function cachePath(cacheDir: string, provider: string, grid: string, day: string): string {
  return join(cacheDir, provider + "_" + grid + "_" + day + ".json")
}

function loadCache(cacheDir: string, provider: string, grid: string, day: string): WeatherSample[] | null {
  try {
    const p = cachePath(cacheDir, provider, grid, day)
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, "utf8")) as { samples?: WeatherSample[] }
    return Array.isArray(j.samples) ? j.samples : null
  } catch { return null }
}

function saveCache(cacheDir: string, provider: string, grid: string, day: string, samples: WeatherSample[]): void {
  try {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cachePath(cacheDir, provider, grid, day), JSON.stringify({ savedAt: new Date().toISOString(), samples }))
  } catch { /* ignore */ }
}

/* ============================ 主入口 ============================ */

/**
 * 按"出发时间 + 位置"给每个路段匹配天气。
 * 每段取段中点时刻与段中点坐标（GCJ-02），按 0.05° 网格聚类去重后逐网格抓取；
 * 匹配顺序：QWeather/OpenWeather 逐小时(hour) → 高德日预报(date) → 高德实时(now)。
 */
export async function enrichSegmentsWithWeather(
  segments: SegmentData[],
  opts: WeatherOptions = {},
): Promise<WeatherResult> {
  const cacheDir = opts.cacheDir ?? "data/weather-cache"
  const windThresholdKmh = opts.windThresholdKmh ?? 10.8
  const useCache = opts.useCache ?? true
  const { qweatherKey, qweatherHost, amapKey, openweatherKey } = getWeatherConfig()
  const result: WeatherResult = { segments, sampled: 0, bySource: {}, queries: 0, provider: "none", windySegments: 0 }
  if (segments.length === 0) return result

  const t0 = opts.departureTime ? new Date(opts.departureTime) : new Date()
  if (Number.isNaN(t0.getTime())) t0.setTime(Date.now())

  // 1) 主源选择
  let provider: "qweather" | "amap" | "openweather" | "none" = "none"
  if (opts.forceProvider) provider = opts.forceProvider
  else if (qweatherKey) provider = "qweather"
  else if (amapKey) provider = "amap"
  else if (openweatherKey) provider = "openweather"
  result.provider = provider
  if (provider === "none") {
    console.warn("[weather] 未配置 QWEATHER_KEY / AMAP_KEY / OPENWEATHER_KEY，跳过天气抓取")
    return result
  }

  // 2) 段元数据：中点时刻 + 中点坐标（GCJ-02）
  let accH = 0
  interface SegMeta { seg: SegmentData; time: Date; grid: string; hk: number; day: string }
  const metas: SegMeta[] = []
  for (const s of segments) {
    const midH = (s.durationH || 0) / 2
    const t = new Date(t0.getTime() + (accH + midH) * 3600000)
    accH += s.durationH || 0
    const coords = s.coordsWgs84 || []
    if (coords.length === 0) { metas.push({ seg: s, time: t, grid: "", hk: 0, day: "" }); continue }
    let lng = 0, lat = 0
    for (const [a, b] of coords) { lng += a; lat += b }
    const [glng, glat] = wgs84ToGcj02(lng / coords.length, lat / coords.length)
    const grid = gridKey(glng, glat)
    metas.push({ seg: s, time: t, grid, hk: hourKey(t), day: localDateKey(t) })
  }

  // 3) 网格去重 + 逐网格抓取
  const grids = [...new Set(metas.map((m) => m.grid).filter(Boolean))]
  const dayKey = localDateKey(t0)
  // hour 级样本：grid|hourKey → sample；day 级样本：grid|YYYY-MM-DD → sample；now：grid|now
  // hour 级样本按网格分组：Map<grid, Map<hourKey, sample>>（QWeather 从『下一个整点』开始，需按最近小时匹配）
  const hourSamples = new Map<string, Map<number, WeatherSample>>();
  const daySamples = new Map<string, WeatherSample>();
  const nowSamples = new Map<string, WeatherSample>();

  for (let gi = 0; gi < grids.length; gi++) {
    if (opts.shouldCancel?.()) break
    opts.onProgress?.({ phase: "weather", done: gi, total: grids.length })
    const grid = grids[gi]
    const [cx, cy] = gridCenter(grid)

    if (provider === "qweather" || provider === "openweather") {
      const cacheProv = provider === "qweather" ? "qweather" : "openweather"
      const cached = useCache ? loadCache(cacheDir, cacheProv, grid, dayKey) : null
      let hourly: Map<number, WeatherSample> | null = null
      if (cached) {
        hourly = new Map()
        for (const s of cached) {
          const d = new Date(s.time)
          if (!Number.isNaN(d.getTime())) hourly.set(hourKey(d), s)
        }
      } else {
        try {
          if (provider === "qweather") hourly = await fetchQweatherHourly(cx, cy, qweatherKey, qweatherHost)
          else {
            const [wlng, wlat] = gcj02ToWgs84(cx, cy)
            hourly = await fetchOpenweatherHourly(wlng, wlat, openweatherKey)
          }
          result.queries += 1
          if (useCache && hourly.size) saveCache(cacheDir, cacheProv, grid, dayKey, [...hourly.values()])
        } catch (e) {
          console.warn("[weather] " + cacheProv + " 抓取失败:", (e as Error).message)
        }
      }
      if (hourly && hourly.size > 0) {
        let g = hourSamples.get(grid)
        if (!g) { g = new Map(); hourSamples.set(grid, g) }
        for (const [hk, s] of hourly) g.set(hk, s)
      } else if (amapKey && provider === "qweather") {
        // QWeather 失败 → 高德日预报兜底
        try {
          const amap = await fetchAmapDaily(cx, cy, amapKey)
          result.queries += 1
          if (amap.now) nowSamples.set(grid + "|now", amap.now)
          for (const [d, s] of amap.byDate) daySamples.set(grid + "|" + d, s)
          if (useCache && amap.byDate.size) saveCache(cacheDir, "amap", grid, dayKey, [...amap.byDate.values(), ...(amap.now ? [amap.now] : [])])
        } catch (e2) {
          console.warn("[weather] 高德兜底也失败:", (e2 as Error).message)
        }
      }
    } else if (provider === "amap") {
      const cached = useCache ? loadCache(cacheDir, "amap", grid, dayKey) : null
      if (cached) {
        for (const s of cached) {
          if (s.time === "now") nowSamples.set(grid + "|now", s)
          else daySamples.set(grid + "|" + s.time, s)
        }
      } else {
        try {
          const amap = await fetchAmapDaily(cx, cy, amapKey)
          result.queries += 1
          if (amap.now) nowSamples.set(grid + "|now", amap.now)
          for (const [d, s] of amap.byDate) daySamples.set(grid + "|" + d, s)
          if (useCache && amap.byDate.size) saveCache(cacheDir, "amap", grid, dayKey, [...amap.byDate.values(), ...(amap.now ? [amap.now] : [])])
        } catch (e) {
          console.warn("[weather] 高德天气抓取失败:", (e as Error).message)
        }
      }
    }
    if (provider === "qweather") await sleep(300)
  }

  // 4) 逐段匹配赋值
  for (const m of metas) {
    if (!m.grid) continue
    let sample = hourSamples.get(m.grid)?.get(m.hk) ?? null
    if (!sample) {
      // QWeather 从『下一个整点』开始预报，路段时刻可能落在两整点之间 → 取最近小时（≤90 分钟）
      const gridHours = hourSamples.get(m.grid)
      if (gridHours) {
        let best: WeatherSample | null = null
        let bestDiff = 5400000 // 90 分钟上限
        for (const [hk, s] of gridHours) {
          const diff = Math.abs(hk * 3600000 - m.time.getTime())
          if (diff < bestDiff) { bestDiff = diff; best = s }
        }
        sample = best
      }
    }
    if (!sample) sample = daySamples.get(m.grid + "|" + m.day) ?? null
    if (!sample) sample = nowSamples.get(m.grid + "|now") ?? null
    if (!sample) continue
    const seg = m.seg
    seg.temperatureC = sample.temperatureC
    seg.windSpeedKmh = sample.windSpeedKmh
    seg.windDirDeg = sample.windDirDeg
    seg.windDirText = sample.windDirText
    seg.humidityPct = sample.humidityPct
    seg.precipMm = sample.precipMm
    seg.weatherText = sample.weatherText
    seg.weatherSource = sample.source
    seg.weatherTime = sample.time
    seg.windAffects = sample.windSpeedKmh != null && sample.windSpeedKmh >= windThresholdKmh
    result.sampled += 1
    result.bySource[sample.source] = (result.bySource[sample.source] || 0) + 1
    if (seg.windAffects) result.windySegments += 1
  }

  return result
}
