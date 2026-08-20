/**
 * 单点历史路段样本：输入一个经度、纬度和过去时间，返回与示例 CSV 对齐的一行。
 *
 * 边界说明：一个坐标不包含完整路段，因此道路名/近期历史天气会尽量查询真实来源，
 * 里程、速度、坡度、启停等路段字段使用仓库现有规则做确定性模拟。
 * 相同输入会得到相同模拟值，适合接口联调与物理模型冒烟测试，不能冒充实测数据。
 */
import type { MotionBehavior, MotionEvent, RoadLevel, SegmentData, TrafficStatus } from './types'
import {
  buildIntersectionEvents,
  CRUISE_SPEED_BY_LEVEL,
  detectMotionBehavior,
  expectedStopCount,
  inferRoadLevel,
  inferStopDensity,
  ROAD_LEVEL_LABEL,
} from './segment'

export const POINT_HISTORY_HEADERS = [
  '序号', '道路', '等级', '里程km', '均速km/h', '坡度%', '海拔m', '爬升m', '下降m',
  '变速情况', '变速概率/期望', '路况', '停车次/km', '时长h', '期望停车次数', '地形',
  '等级来源', '温度℃', '风速km/h', '湿度%', '降水mm', '天气',
] as const

export interface PointHistoryRow {
  序号: number
  道路: string
  等级: string
  '里程km': number
  '均速km/h': number
  '坡度%': number
  '海拔m': number
  '爬升m': number
  '下降m': number
  变速情况: string
  '变速概率/期望': string
  路况: string
  '停车次/km': number
  '时长h': number
  期望停车次数: number
  地形: string
  等级来源: string
  '温度℃': number
  '风速km/h': number
  '湿度%': number
  '降水mm': number
  天气: string
}

export interface PointHistoryInput {
  lng: number
  lat: number
  time: string
}

export interface PointHistoryResult {
  input: PointHistoryInput & { parsedTime: string; coordinateSystem: 'GCJ-02' }
  row: PointHistoryRow
  meta: {
    dataMode: 'simulation-test'
    roadSource: 'amap' | 'simulated'
    weatherSource: 'qweather-history' | 'simulated'
    historicalWeatherAvailable: boolean
    warnings: string[]
  }
}

export interface PointHistoryOptions {
  amapKey?: string
  qweatherKey?: string
  qweatherJwt?: string
  qweatherHost?: string
  now?: Date
  fetchFn?: typeof fetch
}

interface WeatherValue {
  temperatureC: number
  windSpeedKmh: number
  humidityPct: number
  precipMm: number
  weatherText: string
}

interface RoadValue {
  name: string
  source: 'amap' | 'simulated'
}

const TRAFFIC_LABEL: Record<TrafficStatus, string> = {
  smooth: '畅通', slow: '缓行', congested: '拥堵', severe: '严重拥堵', unknown: '未知',
}

const MOTION_LABEL: Record<MotionBehavior, string> = {
  cruise: '巡航', toll: '收费站', intersection: '路口', ramp: '匝道', turn: '转弯',
  serviceArea: '服务区', urbanStopStart: '城市起停',
}

const TERRAIN_LABEL: Record<NonNullable<SegmentData['terrain']>, string> = {
  plain: '平原', hilly: '微丘', heavyHilly: '重丘', mountain: '山岭',
}

function round(value: number, digits = 2): number {
  const n = 10 ** digits
  return Math.round((value + Number.EPSILON) * n) / n
}

/** 兼容 "2026/8/1 10:07"、"2026-08-01 10:07" 和 ISO 字符串。 */
export function parsePointTime(value: string): Date {
  const raw = String(value ?? '').trim()
  if (!raw) throw new Error('缺少 time：请输入过去时间，例如 2026-08-20 10:07')
  const normalized = raw
    .replace(/\//g, '-')
    .replace(/^(\d{4})-(\d{1,2})-(\d{1,2})(\s+)/, (_, y, m, d, gap) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}${gap}`)
    .replace(/\s(\d):(\d{2})(?::(\d{2}))?$/, (_, h, minute, second) => ` ${h.padStart(2, '0')}:${minute}${second ? `:${second}` : ''}`)
    .replace(' ', 'T')
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) throw new Error('time 格式无法识别，请使用 YYYY-MM-DD HH:mm')
  return parsed
}

function validateInput(input: PointHistoryInput, now: Date): Date {
  if (!Number.isFinite(input.lng) || input.lng < -180 || input.lng > 180) throw new Error('lng 必须是 -180 到 180 的数字')
  if (!Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90) throw new Error('lat 必须是 -90 到 90 的数字')
  const time = parsePointTime(input.time)
  if (time.getTime() > now.getTime()) throw new Error('time 必须是过去时间，不能晚于现在')
  return time
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function daysBeforeToday(target: Date, now: Date): number {
  const a = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime()
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return Math.round((b - a) / 86400000)
}

function hashSeed(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function makeRandom(seed: number): () => number {
  let x = seed || 0x6d2b79f5
  return () => {
    x += 0x6d2b79f5
    let t = x
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function qweatherBase(host: string | undefined): string {
  const clean = (host || 'devapi.qweather.com').replace(/^https?:\/\//, '').replace(/\/$/, '')
  return `https://${clean}`
}

function withApiKey(url: URL, key: string | undefined): URL {
  if (key) url.searchParams.set('key', key)
  return url
}

async function fetchJson(fetchFn: typeof fetch, url: URL, jwt?: string): Promise<any> {
  const response = await fetchFn(url, {
    headers: jwt ? { Authorization: `Bearer ${jwt}` } : undefined,
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

async function lookupRoad(input: PointHistoryInput, key: string | undefined, fetchFn: typeof fetch): Promise<RoadValue> {
  if (!key) return { name: '坐标附近道路', source: 'simulated' }
  try {
    const url = new URL('https://restapi.amap.com/v3/geocode/regeo')
    url.searchParams.set('location', `${input.lng.toFixed(6)},${input.lat.toFixed(6)}`)
    url.searchParams.set('extensions', 'all')
    url.searchParams.set('roadlevel', '0')
    url.searchParams.set('key', key)
    const j = await fetchJson(fetchFn, url)
    if (j?.status !== '1') throw new Error('AMap error')
    const roads = Array.isArray(j?.regeocode?.roads) ? j.regeocode.roads : []
    const name = roads.find((r: any) => typeof r?.name === 'string' && r.name.trim())?.name?.trim()
    return name ? { name, source: 'amap' } : { name: '坐标附近道路', source: 'simulated' }
  } catch {
    return { name: '坐标附近道路', source: 'simulated' }
  }
}

function parseHistoricalHour(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const d = new Date(value.trim().replace(' ', 'T'))
  return Number.isNaN(d.getTime()) ? null : d
}

async function lookupHistoricalWeather(
  input: PointHistoryInput,
  time: Date,
  options: PointHistoryOptions,
  fetchFn: typeof fetch,
): Promise<WeatherValue | null> {
  if (!options.qweatherKey && !options.qweatherJwt) return null
  const base = qweatherBase(options.qweatherHost)
  const auth = options.qweatherJwt
  const geoUrl = withApiKey(new URL(`${base}/geo/v2/city/lookup`), options.qweatherKey)
  geoUrl.searchParams.set('location', `${input.lng.toFixed(2)},${input.lat.toFixed(2)}`)
  geoUrl.searchParams.set('number', '1')
  geoUrl.searchParams.set('lang', 'zh')
  const geo = await fetchJson(fetchFn, geoUrl, auth)
  const locationId = Array.isArray(geo?.location) ? geo.location[0]?.id : undefined
  if (geo?.code !== '200' || !locationId) throw new Error('QWeather GeoAPI 未返回 LocationID')

  const historyUrl = withApiKey(new URL(`${base}/v7/historical/weather`), options.qweatherKey)
  historyUrl.searchParams.set('location', String(locationId))
  historyUrl.searchParams.set('date', localDateKey(time))
  historyUrl.searchParams.set('lang', 'zh')
  historyUrl.searchParams.set('unit', 'm')
  const history = await fetchJson(fetchFn, historyUrl, auth)
  if (history?.code !== '200' || !Array.isArray(history?.weatherHourly) || history.weatherHourly.length === 0) {
    throw new Error(`QWeather 历史天气不可用（code=${history?.code ?? '?'}）`)
  }

  let best: any = null
  let bestGap = Number.POSITIVE_INFINITY
  for (const h of history.weatherHourly) {
    const d = parseHistoricalHour(h?.time)
    if (!d) continue
    const gap = Math.abs(d.getTime() - time.getTime())
    if (gap < bestGap) { best = h; bestGap = gap }
  }
  if (!best) return null
  const num = (v: unknown, fallback: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  return {
    temperatureC: num(best.temp, 20),
    windSpeedKmh: num(best.windSpeed, 0),
    humidityPct: num(best.humidity, 50),
    precipMm: num(best.precip, 0),
    weatherText: String(best.text || '未知'),
  }
}

function simulatedWeather(time: Date, lat: number, random: () => number): WeatherValue {
  const month = time.getMonth() + 1
  const seasonal = 17 + 12 * Math.sin(((month - 3) / 12) * Math.PI * 2)
  const latitudePenalty = Math.max(0, Math.abs(lat) - 25) * 0.22
  const diurnal = 4 * Math.sin(((time.getHours() - 8) / 24) * Math.PI * 2)
  const humidity = Math.round(45 + random() * 45)
  const precip = random() > 0.84 ? round(0.2 + random() * 6, 1) : 0
  const weatherText = precip >= 3 ? '中雨' : precip > 0 ? '小雨' : humidity > 80 ? '阴' : random() > 0.5 ? '多云' : '晴'
  return {
    temperatureC: Math.round(seasonal - latitudePenalty + diurnal + (random() - 0.5) * 5),
    windSpeedKmh: Math.round(3 + random() * 18),
    humidityPct: humidity,
    precipMm: precip,
    weatherText,
  }
}

function chooseTraffic(level: RoadLevel, time: Date, random: () => number): TrafficStatus {
  const peak = (time.getHours() >= 7 && time.getHours() <= 9) || (time.getHours() >= 17 && time.getHours() <= 19)
  const r = random()
  if ((level === 'city' || level === 'expressway') && peak) {
    if (r < 0.12) return 'severe'
    if (r < 0.42) return 'congested'
    if (r < 0.75) return 'slow'
  }
  if (r < 0.08) return 'congested'
  if (r < 0.25) return 'slow'
  return 'smooth'
}

function simulatedMotion(level: RoadLevel, traffic: TrafficStatus, distanceKm: number, random: () => number) {
  let instruction = ''
  const r = random()
  if (level === 'city' && r < 0.22) instruction = '经过红绿灯路口'
  else if (level === 'city' && r < 0.38) instruction = '右转进入道路'
  else if ((level === 'highway' || level === 'expressway') && r < 0.12) instruction = '进入匝道'
  const detected = detectMotionBehavior(instruction, level, [], traffic)
  const explicitIntersection = detected.events.some((e) => e.cause === 'intersection') ? 1 : 0
  const background = buildIntersectionEvents(distanceKm, level, traffic, explicitIntersection)
  return { behavior: detected.behavior, events: [...detected.events, ...background] }
}

function motionText(events: MotionEvent[], fallbackStops: number): string {
  const names: Record<MotionEvent['type'], string> = { stop: '停止', start: '启动', decel: '减速', turn: '转弯' }
  const values = events.map((e) => `${names[e.type]}${round(e.expectedCount, 2)}`)
  return values.length ? values.join(';') : `停止${round(fallbackStops, 2)}`
}

function terrainFor(grade: number, climb: number, descent: number): NonNullable<SegmentData['terrain']> {
  const relief = climb + descent
  if (Math.abs(grade) > 8 || relief > 200) return 'mountain'
  if (Math.abs(grade) > 4 || relief > 100) return 'heavyHilly'
  if (Math.abs(grade) > 1.2 || relief > 30) return 'hilly'
  return 'plain'
}

function buildRow(input: PointHistoryInput, time: Date, road: RoadValue, weather: WeatherValue): PointHistoryRow {
  const random = makeRandom(hashSeed(`${input.lng.toFixed(6)}|${input.lat.toFixed(6)}|${time.toISOString()}`))
  const roadLevel = road.source === 'amap' ? inferRoadLevel(road.name, road.name) : 'other'
  const traffic = chooseTraffic(roadLevel, time, random)
  const ranges: Record<RoadLevel, [number, number]> = {
    highway: [1.0, 9.8], national: [0.6, 5.0], provincial: [0.5, 4.0], expressway: [0.5, 4.5],
    city: [0.08, 1.8], county: [0.2, 2.5], other: [0.08, 1.2],
  }
  const [minD, maxD] = ranges[roadLevel]
  const distanceKm = round(minD + random() * (maxD - minD), 2)
  const speedFactor: Record<TrafficStatus, number> = { smooth: 1, slow: 0.72, congested: 0.45, severe: 0.28, unknown: 0.8 }
  const avgSpeedKmh = round(Math.max(8, CRUISE_SPEED_BY_LEVEL[roadLevel] * speedFactor[traffic] * (0.9 + random() * 0.2)), 1)
  const gradePercent = round((random() - 0.5) * (roadLevel === 'highway' ? 4 : 7), 2)
  const netHeight = distanceKm * 1000 * gradePercent / 100
  const undulation = distanceKm * random() * (roadLevel === 'highway' ? 2 : 5)
  const climbM = Math.round(Math.max(0, netHeight) + undulation)
  const descentM = Math.round(Math.max(0, -netHeight) + undulation)
  const elevationM = Math.round(5 + random() * 280)
  const motion = simulatedMotion(roadLevel, traffic, distanceKm, random)
  const stopDensity = inferStopDensity(roadLevel, traffic)
  const segment: SegmentData = {
    index: 0,
    roadName: road.name,
    roadLevel,
    roadSource: 'rule',
    distanceKm,
    avgSpeedKmh,
    gradePercent,
    elevationM,
    trafficStatus: traffic,
    stopDensity,
    motionBehavior: motion.behavior,
    motionEvents: motion.events,
    temperatureC: weather.temperatureC,
    coordsWgs84: [[input.lng, input.lat]],
    durationH: round(distanceKm / avgSpeedKmh, 2),
  }
  const stops = expectedStopCount(segment)
  const terrain = terrainFor(gradePercent, climbM, descentM)
  return {
    序号: 0,
    道路: road.name,
    等级: ROAD_LEVEL_LABEL[roadLevel],
    '里程km': distanceKm,
    '均速km/h': avgSpeedKmh,
    '坡度%': gradePercent,
    '海拔m': elevationM,
    '爬升m': climbM,
    '下降m': descentM,
    变速情况: MOTION_LABEL[motion.behavior],
    '变速概率/期望': motionText(motion.events, stops),
    路况: TRAFFIC_LABEL[traffic],
    '停车次/km': stopDensity,
    '时长h': round(distanceKm / avgSpeedKmh, 2),
    期望停车次数: stops,
    地形: TERRAIN_LABEL[terrain],
    等级来源: road.source === 'amap' ? '高德+规则' : '规则模拟',
    '温度℃': round(weather.temperatureC, 1),
    '风速km/h': round(weather.windSpeedKmh, 1),
    '湿度%': round(weather.humidityPct, 1),
    '降水mm': round(weather.precipMm, 1),
    天气: weather.weatherText,
  }
}

export async function queryPointHistoryRow(input: PointHistoryInput, options: PointHistoryOptions = {}): Promise<PointHistoryResult> {
  const now = options.now ?? new Date()
  const time = validateInput(input, now)
  const fetchFn = options.fetchFn ?? fetch
  const warnings: string[] = ['一个坐标不包含完整路段，里程/速度/坡度/路况/启停为规则模拟值，仅供测试。']
  const road = await lookupRoad(input, options.amapKey, fetchFn)
  if (road.source === 'simulated') warnings.push('没有取得附近真实道路名，已使用模拟道路名。')

  const ageDays = daysBeforeToday(time, now)
  let weather: WeatherValue | null = null
  if (ageDays >= 1 && ageDays <= 10) {
    try {
      weather = await lookupHistoricalWeather(input, time, options, fetchFn)
      if (!weather) warnings.push('未配置可用的和风天气认证，已使用模拟天气。')
    } catch (e: any) {
      warnings.push(`历史天气查询失败，已回退模拟天气：${e?.message || String(e)}`)
    }
  } else {
    warnings.push(ageDays === 0
      ? '和风历史天气不含今天，已使用模拟天气。'
      : '和风普通历史天气仅支持最近10天，目标日期超出范围，已使用模拟天气。')
  }
  const weatherSource = weather ? 'qweather-history' as const : 'simulated' as const
  if (!weather) {
    const random = makeRandom(hashSeed(`weather|${input.lng.toFixed(6)}|${input.lat.toFixed(6)}|${time.toISOString()}`))
    weather = simulatedWeather(time, input.lat, random)
  }

  return {
    input: { ...input, parsedTime: time.toISOString(), coordinateSystem: 'GCJ-02' },
    row: buildRow(input, time, road, weather),
    meta: {
      dataMode: 'simulation-test',
      roadSource: road.source,
      weatherSource,
      historicalWeatherAvailable: weatherSource === 'qweather-history',
      warnings,
    },
  }
}

function csvCell(value: unknown): string {
  const s = String(value ?? '')
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function pointRowToCsv(row: PointHistoryRow): string {
  return [
    POINT_HISTORY_HEADERS.join(','),
    POINT_HISTORY_HEADERS.map((key) => csvCell(row[key])).join(','),
  ].join('\n')
}
