/** OSM 真实路网道路等级验证：纯函数 + 离线匹配场景 + 可选真实线路集成 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OsmWay } from '../src/route/osmRoad'
import {
  chunkCacheKey, chunkRouteCoords, headingAbsDiffDeg, headingParallelDiffDeg,
  isConfidentOsmMatch, matchSegmentsAgainstWays, normalizeOsmRef, osmRoadKey,
  osmTagsToRoadLevel,
} from '../src/route/osmRoad'
import type { RoadLevel, SegmentData } from '../src/route/types'
import { inferStopDensity } from '../src/route/segment'
import { fetchRouteWithSegments } from '../src/route/amapRoute'
import { enrichSegmentsWithOsmRoads } from '../src/route/osmRoad'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
try {
  const envPath = join(ROOT, '.env')
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim()
    }
  }
} catch { /* ignore */ }

let failed = 0
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS', name)
  else { failed++; console.error('  FAIL', name, detail ?? '') }
}

function line(id: number, tags: Record<string, string>, geometry: Array<[number, number]>): OsmWay {
  return { id, tags, geometry }
}

/** 北向折线，每点 0.004°≈444m */
function northLine(lng: number, lat0: number, n = 21): Array<[number, number]> {
  return Array.from({ length: n }, (_, i) => [lng, lat0 + i * 0.004])
}

function mockSeg(coords: Array<[number, number]>, extra: Partial<SegmentData> = {}): SegmentData {
  const level = (extra.roadLevel ?? 'highway') as RoadLevel
  return {
    index: 0,
    roadName: extra.roadName ?? 'G6京藏高速',
    roadLevel: level,
    roadSource: extra.roadSource ?? 'rule',
    distanceKm: extra.distanceKm ?? 8.5,
    avgSpeedKmh: extra.avgSpeedKmh ?? 80,
    gradePercent: null,
    elevationM: null,
    trafficStatus: extra.trafficStatus ?? 'smooth',
    stopDensity: extra.stopDensity ?? inferStopDensity(level, extra.trafficStatus ?? 'smooth'),
    motionBehavior: extra.motionBehavior ?? 'cruise',
    motionEvents: extra.motionEvents ?? [],
    temperatureC: null,
    coordsWgs84: coords,
    durationH: extra.durationH ?? 0.1,
    ...extra,
  }
}

const COS40 = Math.cos((40 * Math.PI) / 180)
const east = (meters: number) => meters / (111320 * COS40)

console.log('— OSM 标签映射（物理证据 > 编号 > 城市路名） —')
assert('motorway → 高速', osmTagsToRoadLevel({ highway: 'motorway' }) === 'highway')
assert('motorway ref=S12 → 高速（省级高速不被 S 编号判成省道）',
  osmTagsToRoadLevel({ highway: 'motorway', ref: 'S12' }) === 'highway')
assert('motorway ref=S50 → 高速', osmTagsToRoadLevel({ highway: 'motorway', ref: 'S50', name: '南五环' }) === 'highway')
assert('S233（3 位）→ 省道', osmTagsToRoadLevel({ highway: 'secondary', ref: 'S233' }) === 'provincial')
assert('S24（1~2 位）→ 省级高速', osmTagsToRoadLevel({ highway: 'secondary', ref: 'S24' }) === 'highway')
assert('G6 → 高速', osmTagsToRoadLevel({ highway: 'motorway', ref: 'G6' }) === 'highway')
assert('G112 → 国道', osmTagsToRoadLevel({ highway: 'trunk', ref: 'G112' }) === 'national')
assert('京G107 → 国道（剥省份简称）', osmTagsToRoadLevel({ highway: 'trunk', ref: '京G107' }) === 'national')
assert('Y012 → 县乡道', osmTagsToRoadLevel({ highway: 'tertiary', ref: 'Y012' }) === 'county')
assert('primary 中山大道 → 市区（不升国道）', osmTagsToRoadLevel({ highway: 'primary', name: '中山大道' }) === 'city')
assert('trunk 创业路 → 市区（不升快速路）', osmTagsToRoadLevel({ highway: 'trunk', name: '创业路' }) === 'city')
assert('trunk 东三环 → 快速路', osmTagsToRoadLevel({ highway: 'trunk', name: '东三环' }) === 'expressway')
assert('name=京藏高速 → 高速', osmTagsToRoadLevel({ highway: 'primary', name: '京藏高速' }) === 'highway')
assert('primary 无名 → 国道（城际兜底）', osmTagsToRoadLevel({ highway: 'primary' }) === 'national')
assert('residential → 市区', osmTagsToRoadLevel({ highway: 'residential' }) === 'city')
assert('unclassified → 其他', osmTagsToRoadLevel({ highway: 'unclassified' }) === 'other')
assert('normalize 京G107', normalizeOsmRef('京G107') === 'G107')
assert('normalize 带空格', normalizeOsmRef('G 107') === 'G107')

console.log('— 道路身份键 —')
assert('无名路按 way.id 区分，不塌成同一个桶',
  osmRoadKey({ highway: 'residential' }, 1) !== osmRoadKey({ highway: 'residential' }, 2))
assert('同 ref 不同 family 合并（省界 trunk/primary 不拆票）',
  osmRoadKey({ highway: 'trunk', ref: 'G107' }) === osmRoadKey({ highway: 'primary', ref: 'G107' }))

console.log('— 航向：双向路接受反向平行 —')
assert('同向夹角 ≈ 0', headingAbsDiffDeg(10, 10) < 1)
assert('反向夹角 ≈ 180', Math.abs(headingAbsDiffDeg(0, 180) - 180) < 1)
assert('反向平行夹角 ≈ 0', headingParallelDiffDeg(0, 180) < 1)
assert('垂直平行夹角 ≈ 90', Math.abs(headingParallelDiffDeg(0, 90) - 90) < 1)

console.log('— 投票置信：分母是采样点数 —')
assert('3/101 点不置信（旧口径会以 100% 通过）', !isConfidentOsmMatch(3, 101, 10, 150))
assert('40/100 且吸附近 → 置信', isConfidentOsmMatch(40, 100, 20, 150))
assert('40/100 但吸附远 → 不置信', !isConfidentOsmMatch(40, 100, 100, 150))

console.log('— 走廊折线含路线末点；缓存键含 bufferM —')
const longCoords = Array.from({ length: 101 }, (_, i) => [116.4, 40 + i * 0.0008] as [number, number])
const chunks = chunkRouteCoords(longCoords, 40, 1000)
const tail = chunks[chunks.length - 1]
const lastQ = tail[tail.length - 1]
const lastR = longCoords[longCoords.length - 1]
assert('走廊查询折线含路线末点', lastQ[0] === lastR[0] && lastQ[1] === lastR[1],
  String(lastQ) + ' vs ' + String(lastR))
const poly: Array<[number, number]> = [[116, 40], [116.1, 40]]
assert('bufferM 进入缓存键（300 ≠ 1000）', chunkCacheKey(poly, 300) !== chunkCacheKey(poly, 1000))

console.log('— 离线匹配：反向数字化的国道不能被小区路抢走 —')
const route = northLine(116.4, 40)
const g107rev = [...route].reverse()
const alley = northLine(116.4 + east(80), 40)
{
  const seg = mockSeg(route, { roadName: 'G107', roadLevel: 'national' })
  matchSegmentsAgainstWays([seg], [line(1, { highway: 'trunk', ref: 'G107' }, g107rev)])
  assert('只有反向 G107 → 仍匹配国道', seg.roadSource === 'osm' && seg.roadLevel === 'national',
    String(seg.roadSource) + '/' + seg.roadLevel)
}
{
  const seg = mockSeg(route, { roadName: 'G107', roadLevel: 'national' })
  matchSegmentsAgainstWays([seg], [
    line(1, { highway: 'trunk', ref: 'G107' }, g107rev),
    line(2, { highway: 'residential', name: '某小区路' }, alley),
  ])
  assert('反向 G107 + 同向小区路 → 仍判国道（不被 80m 外小路抢走）',
    seg.roadLevel === 'national' && (seg.osmRef || '').includes('G107'),
    seg.roadLevel + ' osm=' + seg.osmRef + '/' + seg.osmName)
}

console.log('— 离线匹配：3/101 点碰到 service 路不能改写整段高速 —')
{
  const seg = mockSeg(route, { roadLevel: 'highway', roadName: 'G6京藏高速' })
  const stub = [
    [116.4 + east(60), 40],
    [116.4 + east(60), 40.002],
  ] as Array<[number, number]>
  matchSegmentsAgainstWays([seg], [line(9, { highway: 'service', name: '加油站便道' }, stub)])
  assert('一小截 service 路不改写 8.5km 高速',
    seg.roadLevel === 'highway' && seg.roadSource !== 'osm',
    seg.roadLevel + '/' + seg.roadSource)
}

console.log('— OSM 改等级后停车口径必须跟着重算 —')
{
  const city = mockSeg(route, {
    roadName: '中山大道',
    roadLevel: 'city',
    motionBehavior: 'urbanStopStart',
    stopDensity: inferStopDensity('city', 'smooth'),
  })
  const before = city.stopDensity
  matchSegmentsAgainstWays([city], [line(3, { highway: 'trunk', ref: 'G107' }, route)])
  assert('等级被 OSM 改写', city.roadLevel === 'national', city.roadLevel)
  assert('stopDensity 跟新等级走，不再背着城区口径',
    city.stopDensity === inferStopDensity('national', 'smooth') && city.stopDensity < before,
    String(city.stopDensity) + ' (was ' + before + ')')
}

async function integration() {
  if (!process.env.AMAP_KEY) {
    console.log('\n⚠ 真实线路集成未跑（.env 未读到 AMAP_KEY）。纯函数断言已全部执行。')
    return
  }
  if (process.env.VERIFY_OSM_LIVE !== '1') {
    console.log('\n⚠ 真实线路集成未跑（Overpass 公共镜像不稳定；VERIFY_OSM_LIVE=1 可打开）。已读到 AMAP_KEY。')
    return
  }
  console.log('\n真实线路：乌兰察布→天津 路线1 …')
  const { segments } = await fetchRouteWithSegments('113.13,40.99', '117.19,39.13', 0)
  assert('拿到分段', segments.length > 0, 'segments=' + segments.length)
  const res = await enrichSegmentsWithOsmRoads(segments, {
    cacheDir: join(ROOT, 'data', 'osm-cache'),
    delayMs: 400,
    timeoutMs: 12000,
    queryBudgetMs: 40000,
    onProgress: (p) => { if (p.phase === 'osm-query') console.log('  [osm] ' + p.done + '/' + p.total + ' 走廊分块') },
  })
  console.log('  OSM 结果: 请求=' + res.queries + ' 覆盖=' + res.osmCoveredKm.toFixed(1) + 'km 兜底=' + res.ruleFallbackKm.toFixed(1) + 'km')
  // Overpass 公共镜像经常不可用：有覆盖就断言来源标记；全失败不算测试失败
  if (res.osmCoveredKm > 0) {
    const osmSegs = segments.filter((s) => s.roadSource === 'osm')
    assert('OSM 匹配段带来源标记', osmSegs.length > 0)
    const withRef = osmSegs.filter((s) => s.osmRef || s.osmHighway).length
    assert('OSM 段带 ref/highway 标签', withRef === osmSegs.length, withRef + '/' + osmSegs.length)
    console.log('  抽样 OSM 匹配段（前 8）:')
    for (const s of osmSegs.slice(0, 8)) {
      console.log('    #' + s.index + ' ' + (s.roadName || '-') + ' → ' + s.roadLevel + ' [OSM: ' + (s.osmRef || '') + ' ' + (s.osmName || '') + ' ' + (s.osmHighway || '') + '] ' + s.distanceKm + 'km')
    }
  } else {
    console.log('  ⚠ Overpass 本次无覆盖（公共镜像失败属预期），不把"有匹配"当硬断言')
  }
}

integration().catch((e) => { console.error('  FAIL 集成异常:', e); failed++ }).finally(() => {
  if (failed) { console.error('❌ ' + failed + ' 项失败'); process.exit(1) }
  console.log('✅ 全部通过')
})
