/** 天气模块验证：纯函数单测 + 真实线路集成（需 AMAP_KEY，QWeather 可选） */
import { gridCenter, gridKey, hourKey, enrichSegmentsWithWeather, getWeatherConfig } from '../src/route/weather'
import { fetchRouteWithSegments } from '../src/route/amapRoute'

let failed = 0
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS', name)
  else { failed++; console.error('  FAIL', name, detail ?? '') }
}

// —— 纯函数 ——
const t1 = new Date('2026-08-19T14:30:00+08:00')
assert('hourKey 取整到小时', hourKey(t1) === Math.floor(t1.getTime() / 3600000))
assert('gridKey 0.05° 聚类', gridKey(116.41, 39.92) === gridKey(116.42, 39.91), gridKey(116.41, 39.92) + ' vs ' + gridKey(116.42, 39.91))
assert('gridKey 不同格分离', gridKey(116.41, 39.92) !== gridKey(117.19, 39.13))
const g = gridKey(116.397, 39.908)
const [cx, cy] = gridCenter(g)
assert('gridCenter 回代一致', gridKey(cx, cy) === g)

async function integration() {
  const cfg = getWeatherConfig()
  if (!cfg.amapKey && !cfg.qweatherKey && !cfg.openweatherKey) { console.log('  跳过真实线路集成（未配置任何天气 key）'); return }
  console.log('真实线路：天安门→首都机场 …')
  const { segments } = await fetchRouteWithSegments('116.397,39.908', '116.603,40.078', 0)
  assert('拿到分段', segments.length > 0)
  const res = await enrichSegmentsWithWeather(segments, { cacheDir: 'data/weather-cache', departureTime: new Date().toISOString(), useCache: false })
  console.log('  天气: provider=' + res.provider + ' sampled=' + res.sampled + ' queries=' + res.queries + ' windy=' + res.windySegments + ' ' + JSON.stringify(res.bySource))
  assert('有天气采样', res.sampled > 0)
  const withTemp = segments.filter((s) => s.temperatureC != null).length
  assert('温度已填充', withTemp > 0, withTemp + '/' + segments.length)
  const sample = segments.find((s) => s.temperatureC != null)
  if (sample) console.log('  样例 #' + sample.index + ' ' + (sample.roadName || '-') + ' 温度=' + sample.temperatureC + '℃ 风速=' + sample.windSpeedKmh + 'km/h 湿度=' + sample.humidityPct + '% 降水=' + sample.precipMm + 'mm ' + (sample.weatherText || '') + ' [来源:' + sample.weatherSource + ']')
}

integration().catch((e) => { console.error("  FAIL 集成异常:", e); failed++ }).finally(() => {
  if (failed) { console.error('❌ ' + failed + ' 项失败'); process.exit(1) }
  console.log('✅ 全部通过')
})
