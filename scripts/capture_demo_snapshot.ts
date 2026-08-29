/** 捕获 demo 快照：武汉 → 恩施野三关，全链路数据落成 demo/snapshot.json + demo/route-map.png */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 加载 .env
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf-8').split('\n')) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim()
}
const KEY = process.env.AMAP_KEY
if (!KEY) throw new Error('缺少 AMAP_KEY')

const { fetchRoutePlan, fetchRouteWithSegments } = await import('../src/route/amapRoute')
const { enrichSegmentsWithDem } = await import('../src/route/demFetch')
const { enrichSegmentsWithOsmRoads } = await import('../src/route/osmRoad')
const { enrichSegmentsWithWeather } = await import('../src/route/weather')
const { summarizeSegments, expectedStopCount } = await import('../src/route/segment')
const { recommendRoute, getAiConfig } = await import('../src/route/ai')
const COST = { h2Price: 35, dieselPrice: 7.5, dieselL100: 30, driverRate: 60, otherPerKm: 0.5 }
const VEHICLE = { curbKg: 9700, crr: 0.009, cd: 0.35, frontArea: 7.5, etaMt: 0.9, pFcMin: 30, pFcMax: 180, pBatMax: 150, etaFc: 0.5, pAux0: 3.0, kT: 0.15 }
const loadT = 30

const log = (...a: any[]) => { console.log('[capture]', ...a) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function geocode(addr: string): Promise<string> {
  const url = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(addr)}&key=${KEY}`
  const r = await fetch(url); const j: any = await r.json()
  const loc = j?.geocodes?.[0]?.location
  if (!loc) throw new Error('地理编码失败: ' + addr)
  return loc as string
}
function bearing(a: [number, number], b: [number, number]): number | null {
  const p1 = a[1]*Math.PI/180, p2 = b[1]*Math.PI/180, dl = (b[0]-a[0])*Math.PI/180
  const y = Math.sin(dl)*Math.cos(p2), x = Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl)
  return (Math.atan2(y,x)*180/Math.PI+360)%360
}
function stopSecondsFor(b: any): number {
  return ({ toll: 60, serviceArea: 40, intersection: 30, ramp: 20, turn: 10 } as any)[b] ?? 30
}
function buildSlim(seg: any) {
  const coords = seg.coordsWgs84 ?? []
  const hd = coords.length >= 2 ? bearing(coords[0], coords[coords.length-1]) : null
  const stopCount = (seg.motionEvents ?? []).reduce((a: number, e: any) => a + (e.expectedCount ?? 0), 0)
  return {
    index: seg.index, roadName: seg.roadName ?? '', distanceKm: seg.distanceKm, avgSpeedKmh: seg.avgSpeedKmh,
    gradePercent: seg.gradePercent, elevationM: seg.elevationM, temperatureC: seg.temperatureC,
    windSpeedKmh: seg.windSpeedKmh, humidityPct: seg.humidityPct, roadLevel: seg.roadLevel, durationH: seg.durationH,
    windDirDeg: seg.windDirDeg ?? null, windDirText: seg.windDirText ?? '', windAffects: seg.windAffects ?? false,
    headingDeg: hd, massKg: Math.round(VEHICLE.curbKg + loadT*1000), gainM: seg.elevationGainM ?? 0,
    stopCount: Math.max(0, stopCount), stopSecondsPer: stopSecondsFor(seg.motionBehavior),
    crr: VEHICLE.crr, cd: VEHICLE.cd, frontArea: VEHICLE.frontArea, eta_mt: VEHICLE.etaMt,
    p_fc_min: VEHICLE.pFcMin, p_fc_max: VEHICLE.pFcMax, p_bat_max: VEHICLE.pBatMax,
    eta_fc: VEHICLE.etaFc, p_aux0: VEHICLE.pAux0, k_t: VEHICLE.kT,
  }
}
function runPython(script: string, input: string): Promise<any> {
  return new Promise((resolve) => {
    const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
    const cwd = path.join(__dirname, '..', 'ml')
    const child = spawn(py, [script], { cwd })
    let out = '', err = ''
    child.stdout.on('data', d => out += d.toString())
    child.stderr.on('data', d => err += d.toString())
    child.on('close', () => { try { resolve(JSON.parse(out)) } catch { resolve({ ok: false, msg: err.slice(0, 200) }) } })
    child.stdin.write(input); child.stdin.end()
  })
}
function calcCost(c: any, physics: any) {
  const phTotal = physics?.total_h2_kg ?? 0
  const fuel = phTotal * COST.h2Price
  const toll = c.tollsYuan || 0
  const driver = (c.durationH || 0) * COST.driverRate
  const other = c.distanceKm * COST.otherPerKm
  const total = fuel + toll + driver + other
  const diesel = c.distanceKm * (COST.dieselL100/100) * COST.dieselPrice
  const dieselTotal = diesel + toll + driver + other
  const r1 = (n: number) => Math.round(n*10)/10
  return { fuelYuan: r1(fuel), tollYuan: r1(toll), driverYuan: r1(driver), otherYuan: r1(other),
           totalYuan: r1(total), dieselYuan: r1(diesel), dieselTotalYuan: r1(dieselTotal), deltaYuan: r1(total-dieselTotal) }
}
function compactSeg(seg: any) {
  const s: any = { ...seg }
  delete s.coordsWgs84
  s.coordCount = (seg.coordsWgs84 ?? []).length
  return s
}

// ---- 主流程 ----
const originName = '武汉市', destinationName = '恩施野三关'
log('地理编码...')
const origin = await geocode('武汉市')
const destination = await geocode('恩施土家族苗族自治州巴东县野三关')
log('origin:', origin, '| destination:', destination)
const departureTime = new Date().toISOString()

log('拉取候选路线...')
const plan = await fetchRoutePlan(origin, destination)
const candidates = plan.routes.slice(0, 3)
log('候选路线:', candidates.length, '|', candidates.map(c => c.distanceKm + 'km').join(', '))

const routes: any[] = []
for (let i = 0; i < candidates.length; i++) {
  log(`路线 ${i+1}: 分段 + DEM/OSM/天气...`)
  const { candidate, segments } = await fetchRouteWithSegments(origin, destination, i)
  const dem = await enrichSegmentsWithDem(segments, { cacheDir: path.join(__dirname, '..', 'data', 'dem-cache') })
  const osm = await enrichSegmentsWithOsmRoads(dem.segments, { cacheDir: path.join(__dirname, '..', 'data', 'osm-cache') })
  const w = await enrichSegmentsWithWeather(osm.segments, { cacheDir: path.join(__dirname, '..', 'data', 'weather-cache'), departureTime })
  const enriched = w.segments
  log(`  路段数 ${enriched.length}; 天气: ${w.provider} ${w.sampled} 段匹配`)
  // hour 特征
  const dep = new Date(departureTime); let accH = 0
  const slim = enriched.map((s: any) => { const hour = new Date(dep.getTime()+accH*3600000).getHours(); accH += Number(s.durationH)||0; return { ...buildSlim(s), hour } })
  const input = JSON.stringify({ departure_hour: dep.getHours(), segments: slim })
  log('  双引擎预测...')
  const ml = await runPython('predict.py', input)
  const physics = await runPython('physics.py', input)
  const cost = calcCost(candidate, physics)
  routes.push({ index: i, candidate, segments: enriched.map(compactSeg), summary: summarizeSegments(enriched), ml, physics, cost })
  log(`  ML ${ml?.total_h2_kg}kg / 物理 ${physics?.total_h2_kg}kg / 费用 ${cost.totalYuan}元`)
}

log('AI 推荐...')
let ai: any = null, aiError = ''
try {
  const cfg = getAiConfig()
  const rep = await recommendRoute({
    origin: originName, destination: destinationName,
    routes: routes.map(r => ({ index: r.index, distanceKm: r.candidate.distanceKm, durationH: r.candidate.durationH,
      tollsYuan: r.candidate.tollsYuan, avgSpeedKmh: r.candidate.avgSpeedKmh, highwayRatio: r.candidate.highwayRatio,
      ml: { totalH2Kg: r.ml?.total_h2_kg ?? 0, per100kmKg: r.ml?.per100km_kg ?? 0 },
      physics: { totalH2Kg: r.physics?.total_h2_kg ?? 0, per100kmKg: r.physics?.per100km_kg ?? 0 },
      cost: r.cost })),
  }, cfg)
  ai = { text: rep.text, model: rep.model }
} catch (e: any) { aiError = (e && e.message) || String(e) }

const outDir = path.join(__dirname, '..', 'demo')
fs.mkdirSync(outDir, { recursive: true })
const snapshot = { meta: { origin, destination, originName, destinationName, departureTime, capturedAt: new Date().toISOString(), vehicle: VEHICLE, loadT, costAssumptions: COST }, candidates, routes, ai, aiError }
fs.writeFileSync(path.join(outDir, 'snapshot.json'), JSON.stringify(snapshot))
log('已保存 demo/snapshot.json', fs.statSync(path.join(outDir, 'snapshot.json')).size, 'bytes')

// 静态地图：取费用最低路线画底图
const best = routes.reduce((a, b) => (b.cost.totalYuan < a.cost.totalYuan ? b : a), routes[0])
const poly = best.candidate.polyline || (best.segments[0] ? '' : '')
let mapUrl = `https://restapi.amap.com/v3/staticmap?zoom=7&size=750*420&key=${KEY}&markers=mid,,A:${origin}|mid,,B:${destination}`
if (poly) mapUrl += `&paths=color:0x3A7BFF,weight:5|${poly}`
try {
  const r = await fetch(mapUrl); const buf = Buffer.from(await r.arrayBuffer())
  fs.writeFileSync(path.join(outDir, 'route-map.png'), buf)
  log('已保存 demo/route-map.png', buf.length, 'bytes')
} catch (e) { log('静态地图失败:', (e as any)?.message) }
log('完成 ✅')