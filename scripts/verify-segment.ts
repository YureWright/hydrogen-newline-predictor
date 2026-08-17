/** A1 分段切片验证：纯函数自测 + 真实线路分段（需 AMAP_KEY） */
import type { AmapRawPath } from '../src/route/types'
import {
  buildSegments, dominantTrafficStatus, extractRoadName,
  inferRoadLevel, inferStopDensity, summarizeSegments,
} from '../src/route/segment'
import { decodePolyline, gcj02ToWgs84, outOfChina, wgs84ToGcj02 } from '../src/route/coords'
import { fetchRouteWithSegments } from '../src/route/amapRoute'

let failed = 0
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS', name)
  else { failed++; console.error('  FAIL', name, detail ?? '') }
}

/** 构造一条 3 段的高德原始路线（纯函数测试夹具） */
function makeFixturePath(): AmapRawPath {
  return {
    distance: '36000',
    duration: '1800',
    tolls: '60',
    toll_distance: '34000',
    steps: [
      {
        instruction: '沿G6京藏高速途径前河大桥向东行驶20公里',
        distance: '20000',
        duration: '900',
        tolls: '40',
        toll_distance: '20000',
        polyline: '113.13,40.99;113.4,41.0;113.7,41.01',
        tmcs: [
          { status: '畅通', distance: '15000', polyline: '' },
          { status: '缓行', distance: '5000', polyline: '' },
        ],
      },
      {
        instruction: '沿北六环向西行驶12公里',
        distance: '12000',
        duration: '1200',
        tolls: '0',
        toll_distance: '0',
        polyline: '113.7,41.01;114.1,40.9;114.3,40.8',
        tmcs: [{ status: '拥堵', distance: '12000', polyline: '' }],
      },
      {
        instruction: '行驶2公里到达终点',
        distance: '4000',
        duration: '600',
        tolls: '0',
        toll_distance: '0',
        polyline: '114.3,40.8;114.4,40.78',
        tmcs: [],
      },
    ],
  }
}

async function main() {
  console.log('=== A1 分段切片 · 纯函数自测 ===')

  // 坐标系
  const wgs = [116.3913, 39.9072] as const // 天安门 WGS-84 近似
  const gcj = wgs84ToGcj02(wgs[0], wgs[1])
  const back = gcj02ToWgs84(gcj[0], gcj[1])
  assert('GCJ↔WGS 往返误差 <0.0001°', Math.abs(back[0] - wgs[0]) < 0.0001 && Math.abs(back[1] - wgs[1]) < 0.0001, `back=${back}`)
  assert('境外坐标透传（GCJ→WGS 不变）', gcj02ToWgs84(0, 0)[0] === 0 && outOfChina(0, 0))
  const dec = decodePolyline('116.0,39.9;116.1,39.91')
  assert('decodePolyline 解析', dec.length === 2 && dec[0][0] === 116.0)

  // 道路名提取
  assert('extractRoadName: G6京藏高速', extractRoadName('沿G6京藏高速途径前河大桥向东行驶90.7公里') === 'G6京藏高速')
  assert('extractRoadName: S15京津高速', extractRoadName('沿徐庄桥途径S15京津高速、样田桥向东行驶') === 'S15京津高速')
  assert('extractRoadName: 北六环（fallback）', extractRoadName('沿百葛桥途径北六环向东行驶') === '百葛桥')

  // 道路等级
  assert('roadLevel: G6京藏高速→highway', inferRoadLevel('G6京藏高速', '') === 'highway')
  assert('roadLevel: G105国道→national', inferRoadLevel('G105国道', '') === 'national')
  assert('roadLevel: S234省道→provincial', inferRoadLevel('S234省道', '') === 'provincial')
  assert('roadLevel: 北六环→city', inferRoadLevel('北六环', '') === 'city')
  assert('roadLevel: 无关键词+收费>0→highway', inferRoadLevel('京津快速', '', 3000) === 'highway')
  assert('roadLevel: 京津快速(免费)→city', inferRoadLevel('京津快速', '') === 'city')
  assert('roadLevel: 未知→other', inferRoadLevel('', '左转') === 'other')

  // 路况主导状态（距离加权）
  const dom = dominantTrafficStatus([
    { status: '畅通', distance: '15000' },
    { status: '缓行', distance: '5000' },
  ])
  assert('dominantTraffic: 距离加权→smooth', dom === 'smooth')
  assert('dominantTraffic: 空→unknown', dominantTrafficStatus([]) === 'unknown')

  // 停车密度
  assert('stopDensity: 高速+畅通=0.02', inferStopDensity('highway', 'smooth') === 0.02)
  assert('stopDensity: 城区+拥堵=6', inferStopDensity('city', 'congested') === 6)
  assert('stopDensity: 高速+严重=0.1', inferStopDensity('highway', 'severe') === 0.1)

  // 分段切片（夹具）
  const segs = buildSegments(makeFixturePath())
  assert('buildSegments: 3 段', segs.length === 3, String(segs.length))
  const totalKm = segs.reduce((a, s) => a + s.distanceKm, 0)
  assert('buildSegments: 里程合计 36km', Math.abs(totalKm - 36) < 0.01, String(totalKm))
  assert('buildSegments: 段0 roadLevel=highway', segs[0].roadLevel === 'highway')
  assert('buildSegments: 段0 路况=smooth（加权）', segs[0].trafficStatus === 'smooth')
  assert('buildSegments: 段1 路况=congested', segs[1].trafficStatus === 'congested')
  assert('buildSegments: 段0 均速=80km/h', Math.abs(segs[0].avgSpeedKmh - 80) < 0.5, String(segs[0].avgSpeedKmh))
  assert('buildSegments: 段2 均速=24km/h(4000m/600s)', Math.abs(segs[2].avgSpeedKmh - 24) < 0.5, String(segs[2].avgSpeedKmh))
  assert('buildSegments: 段0 坐标转 WGS-84（与 GCJ 偏差<0.02°）',
    Math.abs(segs[0].coordsWgs84[0][0] - 113.13) < 0.02 && Math.abs(segs[0].coordsWgs84[0][1] - 40.99) < 0.02,
    JSON.stringify(segs[0].coordsWgs84[0]))
  assert('buildSegments: 坡度/海拔/温度暂为 null', segs[0].gradePercent === null && segs[0].elevationM === null && segs[0].temperatureC === null)

  // 路级汇总
  const sum = summarizeSegments(segs)
  assert('summarize: totalKm≈36', Math.abs(sum.totalKm - 36) < 0.01, String(sum.totalKm))
  assert('summarize: highwayKm=20', Math.abs(sum.roadLevelKm.highway - 20) < 0.01, String(sum.roadLevelKm.highway))
  assert('summarize: cityKm=12', Math.abs(sum.roadLevelKm.city - 12) < 0.01, String(sum.roadLevelKm.city))
  assert('summarize: 加权均速≈(20*80+12*36+4*24)/36≈59.1', Math.abs(sum.avgSpeedKmh - (20 * 80 + 12 * 36 + 4 * 24) / 36) < 0.5, String(sum.avgSpeedKmh))
  assert('summarize: 无坡度数据→null', sum.avgGradePercent === null)

  console.log('=== 真实线路分段（需 AMAP_KEY） ===')
  if (!process.env.AMAP_KEY) {
    console.log('  未配置 AMAP_KEY，跳过真实线路验证（纯函数自测已完成）')
  } else {
    try {
      await mainReal()
    } catch (e: any) {
      failed++; console.error('  真实线路失败:', e.message || e)
    }
  }

  console.log('')
  console.log('=== 结果 ===', failed === 0 ? '全部通过 ✅' : failed + ' 项失败 ❌')
  process.exit(failed === 0 ? 0 : 1)
}

async function mainReal() {
  const { candidate, segments } = await fetchRouteWithSegments('113.13,40.99', '117.19,39.13', 0)
  console.log(`  ${candidate.distanceKm}km / ${candidate.durationH}h / 高速占比${(candidate.highwayRatio * 100).toFixed(0)}% → ${segments.length} 段`)
  const sum = summarizeSegments(segments)
  console.log('  路级汇总:', JSON.stringify({
    总里程: sum.totalKm, 总时长h: sum.totalDurationH, 加权均速: sum.avgSpeedKmh,
    高速km: sum.roadLevelKm.highway, 国道km: sum.roadLevelKm.national,
    省道km: sum.roadLevelKm.provincial, 城市km: sum.roadLevelKm.city, 其他km: sum.roadLevelKm.other,
  }))
  const top = [...segments].sort((a, b) => b.distanceKm - a.distanceKm).slice(0, 8)
  console.log('  最长 8 段:')
  for (const s of top) {
    console.log(`    [${String(s.index).padStart(2)}] ${(s.distanceKm + 'km').padStart(7)} @${String(s.avgSpeedKmh).padStart(5)}km/h ${s.trafficStatus.padEnd(9)} ${s.roadLevel.padEnd(10)} ${s.roadName}`)
  }
}

main().catch((e) => { console.error('运行失败:', e); process.exit(1) })