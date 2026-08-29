/** 验证重卡车速系数：拉一条真实路线，打印路线级+段级 轿车速度 vs 重卡速度 对比 */
import * as fs from 'node:fs'
// 手动加载 .env（与 server 一致，避免依赖 dotenv）
for (const line of fs.readFileSync('.env', 'utf-8').split('\n')) {
  const m = line.match(/^([A-Za-z_]+)=(.*)$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim()
}
const { fetchRouteWithSegments } = await import('../src/route/amapRoute')

const origin = process.argv[2] ?? '116.326,39.997'   // 清华
const dest   = process.argv[3] ?? '117.190,39.125'   // 天津
const { candidate, segments } = await fetchRouteWithSegments(origin, dest, 0)
console.log('=== 路线级 ===')
console.log(`距离 ${candidate.distanceKm}km  时长 ${candidate.durationH}h  均速 ${candidate.avgSpeedKmh}km/h  高速占比 ${(candidate.highwayRatio*100).toFixed(0)}%`)
console.log('=== 段级（前 12 段，重卡速度） ===')
for (const s of segments.slice(0, 12)) {
  console.log(`  ${String(s.roadLevel).padEnd(11)} ${String(s.distanceKm).padStart(6)}km ${String(s.avgSpeedKmh).padStart(5)}km/h ${s.durationH}h  ${s.roadName || ''}`.slice(0, 110))
}
const byLevel: Record<string, {n:number, v:number}> = {}
for (const s of segments) {
  const e = byLevel[s.roadLevel] ?? { n: 0, v: 0 }
  e.n += 1; e.v += s.avgSpeedKmh * s.distanceKm
  byLevel[s.roadLevel] = e
}
console.log('=== 段级加权均速（按道路等级） ===')
for (const [lv, e] of Object.entries(byLevel)) {
  console.log(`  ${lv.padEnd(11)} 加权均速 ${(e.v / segments.filter(x=>x.roadLevel===lv).reduce((a,x)=>a+x.distanceKm,0) || 0).toFixed(1)} km/h  (${e.n} 段)`)
}