/** 路线路况模块验证：纯函数自测 + 3 条真实线路 */
import { fetchRoutePlan } from '../src/route/amapRoute'
import { loadStations, findNearbyStations } from '../src/route/stationLayer'
import {
  avgSpeedKmh, extractRoadsFromSteps, highwayRatio,
  mapTrafficStatus, pointToPolylineDist, sumTraffic,
} from '../src/route/parse'

let failed = 0
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS', name)
  else { failed++; console.error('  FAIL', name, detail ?? '') }
}

async function main() {
  console.log('=== 纯函数自测 ===')
  assert('mapTrafficStatus: 严重拥堵→severe', mapTrafficStatus('严重拥堵') === 'severe')
  assert('mapTrafficStatus: 拥堵→congested', mapTrafficStatus('拥堵') === 'congested')
  assert('mapTrafficStatus: 缓行→slow', mapTrafficStatus('缓行') === 'slow')
  assert('mapTrafficStatus: 畅通→smooth', mapTrafficStatus('畅通') === 'smooth')
  assert('mapTrafficStatus: 未知→unknown', mapTrafficStatus('?') === 'unknown')
  assert('highwayRatio: 460/490km ≈0.94', Math.abs(highwayRatio(460000, 490000) - 0.939) < 0.01)
  assert('avgSpeed: 490km/6.5h ≈75.4', Math.abs(avgSpeedKmh(490000, 6.5 * 3600) - 75.4) < 0.5)
  const stats = sumTraffic(
    [{ status: '畅通', distance: '10000' }, { status: '缓行', distance: '2000' }, { status: '拥堵', distance: '1000' }],
    13,
  )
  assert('sumTraffic: 拥堵比例=(2+1)/13≈0.23', Math.abs(stats.congestionRatio - 3 / 13) < 0.01)
  const roads = extractRoadsFromSteps([
    { instruction: '沿G6京藏高速行驶20公里', distance: '20000' },
    { instruction: '沿G6京藏高速行驶10公里', distance: '10000' },
    { instruction: '沿京津快速行驶5公里', distance: '5000' },
  ])
  assert('extractRoads: 主要道路排序', roads[0] === 'G6京藏高速' && roads[1] === '京津快速', roads.join(','))
  const d = pointToPolylineDist(116.0, 40.0, [[116.0, 39.9], [116.5, 39.9]])
  assert('pointToPolylineDist: ≈11km', d > 10000 && d < 12000, String(d))

  console.log('\n=== 真实线路验证 ===')
  const cases: Array<[string, string, string]> = [
    ['113.13,40.99', '117.19,39.13', '乌兰察布 → 天津'],
    ['116.407,39.904', '121.473,31.230', '北京 → 上海'],
    ['113.264,23.129', '114.057,22.543', '广州 → 深圳'],
  ]
  const stations = loadStations('data/stations.geojson')
  console.log('加载加氢站:', stations.length, '座')

  for (const [o, d, label] of cases) {
    console.log('\n----', label)
    const plan = await fetchRoutePlan(o, d)
    plan.routes.forEach((r, i) => {
      console.log(
        `  [route${i + 1}] ${r.distanceKm}km ${r.durationH}h 收费${r.tollsYuan}元 高速占比${(r.highwayRatio * 100).toFixed(0)}% 均速${r.avgSpeedKmh}km/h`,
      )
      console.log(
        `      路况: 畅通${r.traffic.smoothKm}km 缓行${r.traffic.slowKm} 拥堵${r.traffic.congestedKm} 严重${r.traffic.severeKm} (拥堵占比${(r.traffic.congestionRatio * 100).toFixed(1)}%)`,
      )
      console.log('      主要道路:', r.topRoads.slice(0, 5).join(' | '))
    })
    const nearby = findNearbyStations(plan.routes[0].polyline, stations, 20, 8)
    console.log(`  路线1 沿线20km内加氢站 ${nearby.length} 座:`)
    for (const s of nearby.slice(0, 5)) {
      console.log(`    - ${s.name} 距线${s.distanceKm}km 价格${s.price ?? '-'}元 ${s.pressure} 枪${s.guns ?? '-'}`)
    }
  }

  console.log('\n=== 结果 ===', failed === 0 ? '全部通过 ✅' : failed + ' 项失败 ❌')
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error('运行失败:', e); process.exit(1) })
