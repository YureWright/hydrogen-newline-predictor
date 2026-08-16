/** 路线路况模块交互式 Demo
 * 用法：
 *   npm run demo                        # 交互选择示例线路或输入起终点
 *   npm run demo -- 113.13,40.99 117.19,39.13   # 直接指定起终点（lng,lat）
 */
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { fetchRoutePlan } from '../src/route/amapRoute'
import { loadStations, findNearbyStations } from '../src/route/stationLayer'

const EXAMPLES: Array<[string, string, string]> = [
  ['113.13,40.99', '117.19,39.13', '乌兰察布 → 天津（命题示例干线）'],
  ['116.407,39.904', '121.473,31.230', '北京 → 上海（超长途）'],
  ['113.264,23.129', '114.057,22.543', '广州 → 深圳（珠三角城际）'],
  ['114.058,22.543', '113.13,40.99', '深圳 → 乌兰察布（反向长途）'],
]

const TRAFFIC_LABEL: Record<string, string> = {
  smooth: '畅通', slow: '缓行', congested: '拥堵', severe: '严重拥堵', unknown: '未知',
}

async function query(origin: string, destination: string, label: string) {
  console.log('\n==========================================')
  console.log('  路线查询:', label)
  console.log('  起点:', origin, ' 终点:', destination)
  console.log('==========================================')

  const stations = loadStations('data/stations.geojson')
  const plan = await fetchRoutePlan(origin, destination)

  plan.routes.forEach((r, i) => {
    const t = r.traffic
    const blockedPct = (t.congestionRatio * 100).toFixed(1)
    console.log(`\n── 候选路线 ${i + 1} ──`)
    console.log(`  里程: ${r.distanceKm} km | 时长: ${r.durationH} h | 过路费: ${r.tollsYuan} 元 | 均速: ${r.avgSpeedKmh} km/h`)
    console.log(`  高速占比: ${(r.highwayRatio * 100).toFixed(0)}% （收费里程 ${r.tollDistanceKm}km / 总里程 ${r.distanceKm}km）`)
    console.log(`  实时路况: 畅通 ${t.smoothKm}km | 缓行 ${t.slowKm}km | 拥堵 ${t.congestedKm}km | 严重 ${t.severeKm}km （拥堵占比 ${blockedPct}%）`)
    console.log(`  主要道路: ${r.topRoads.slice(0, 6).join(' → ') || '（未识别）'}`)
    const nearby = findNearbyStations(r.polyline, stations, 20, 6)
    console.log(`  沿线20km加氢站: ${nearby.length} 座`)
    for (const s of nearby) {
      const p = s.price != null ? s.price + ' 元' : '未知'
      console.log(`    · ${s.name} ｜ 距线 ${s.distanceKm}km ｜ ${p} ｜ ${s.pressure || '-'} ｜ 枪${s.guns ?? '-'}`)
    }
  })
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length >= 2) {
    await query(args[0], args[1], args[0] + ' → ' + args[1])
    return
  }
  const rl = readline.createInterface({ input, output })
  console.log('=== 路线路况模块 Demo ===')
  console.log('请选择示例线路（输入序号 1-4），或输入 0 自定义起终点：')
  EXAMPLES.forEach(([, , label], i) => console.log(`  ${i + 1}. ${label}`))
  const ans = (await rl.question('> ')).trim()
  if (ans === '0') {
    const o = (await rl.question('起点（lng,lat，如 116.407,39.904）: ')).trim()
    const d = (await rl.question('终点（lng,lat）: ')).trim()
    rl.close()
    await query(o, d, o + ' → ' + d)
    return
  }
  rl.close()
  const idx = Number(ans) - 1
  if (!EXAMPLES[idx]) { console.log('无效输入'); return }
  const [o, d, label] = EXAMPLES[idx]
  await query(o, d, label)
}

main().catch((e) => { console.error('运行失败:', e); process.exit(1) })
