/** OSM 真实路网道路等级验证：纯函数单测 + 真实线路集成（需 AMAP_KEY + 网络） */
import { osmTagsToRoadLevel } from '../src/route/osmRoad'
import { fetchRouteWithSegments } from '../src/route/amapRoute'
import { enrichSegmentsWithOsmRoads } from '../src/route/osmRoad'

let failed = 0
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS', name)
  else { failed++; console.error('  FAIL', name, detail ?? '') }
}

// —— OSM 标签/编号 → RoadLevel 映射 ——
assert('motorway → 高速', osmTagsToRoadLevel({ highway: 'motorway' }) === 'highway')
assert('trunk → 快速路', osmTagsToRoadLevel({ highway: 'trunk' }) === 'expressway')
assert('primary → 国道', osmTagsToRoadLevel({ highway: 'primary' }) === 'national')
assert('secondary → 省道', osmTagsToRoadLevel({ highway: 'secondary' }) === 'provincial')
assert('tertiary → 县乡道', osmTagsToRoadLevel({ highway: 'tertiary' }) === 'county')
assert('residential → 市区', osmTagsToRoadLevel({ highway: 'residential' }) === 'city')
assert('unclassified → 其他', osmTagsToRoadLevel({ highway: 'unclassified' }) === 'other')
assert('ref=G6 → 高速', osmTagsToRoadLevel({ highway: 'motorway', ref: 'G6' }) === 'highway')
assert('ref=G112 → 国道', osmTagsToRoadLevel({ highway: 'trunk', ref: 'G112' }) === 'national')
assert('ref=S24 → 省道', osmTagsToRoadLevel({ highway: 'secondary', ref: 'S24' }) === 'provincial')
assert('name=京藏高速 → 高速', osmTagsToRoadLevel({ highway: 'primary', name: '京藏高速' }) === 'highway')

async function integration() {
  if (!process.env.AMAP_KEY) { console.log('  跳过真实线路集成（缺 AMAP_KEY）'); return }
  console.log('真实线路：乌兰察布→天津 路线1 …')
  const { segments } = await fetchRouteWithSegments('113.13,40.99', '117.19,39.13', 0)
  assert('拿到分段', segments.length > 0, 'segments=' + segments.length)
  const before = segments.reduce((m, s) => { m[s.roadLevel] = (m[s.roadLevel] || 0) + s.distanceKm; return m }, {} as Record<string, number>)
  const res = await enrichSegmentsWithOsmRoads(segments, {
    cacheDir: 'data/osm-cache',
    delayMs: 600,
    onProgress: (p) => { if (p.phase === 'osm-query') console.log('  [osm] ' + p.done + '/' + p.total + ' 走廊分块') },
  })
  console.log('  OSM 结果: 请求=' + res.queries + ' 覆盖=' + res.osmCoveredKm.toFixed(1) + 'km 兜底=' + res.ruleFallbackKm.toFixed(1) + 'km')
  assert('有 OSM 匹配', res.osmCoveredKm > 0)
  const after = segments.reduce((m, s) => { m[s.roadLevel] = (m[s.roadLevel] || 0) + s.distanceKm; return m }, {} as Record<string, number>)
  console.log('  等级里程 before:', JSON.stringify(before))
  console.log('  等级里程 after :', JSON.stringify(after))
  const osmSegs = segments.filter((s) => s.roadSource === 'osm')
  assert('OSM 匹配段带来源标记', osmSegs.length > 0)
  const withRef = osmSegs.filter((s) => s.osmRef || s.osmHighway).length
  assert('OSM 段带 ref/highway 标签', withRef === osmSegs.length, withRef + '/' + osmSegs.length)
  // 抽样打印前 8 条 OSM 匹配段
  console.log('  抽样 OSM 匹配段（前 8）:');
  for (const s of osmSegs.slice(0, 8)) {
    console.log('    #' + s.index + ' ' + (s.roadName || '-') + ' → ' + s.roadLevel + ' [OSM: ' + (s.osmRef || '') + ' ' + (s.osmName || '') + ' ' + (s.osmHighway || '') + '] ' + s.distanceKm + 'km')
  }
}

integration().catch((e) => { console.error("  FAIL 集成异常:", e); failed++ }).finally(() => {
  if (failed) { console.error('❌ ' + failed + ' 项失败'); process.exit(1) }
  console.log('✅ 全部通过')
})
