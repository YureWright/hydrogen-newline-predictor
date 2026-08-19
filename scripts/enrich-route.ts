/** 路段高程提取 CLI：下载 DEM 瓦片（预热缓存）+ 打印带坡度/海拔/地形的路段表
 * 用法：
 *   npm run enrich                             # 默认 乌兰察布→天津 路线1
 *   npm run enrich -- 113.13,40.99 117.19,39.13 1
 *
 * 流程：高德取路线 → 规则推断道路等级（兜底）→ DEM 高程 + 坡度切分
 *       → OSM 真实路网升级道路等级（无匹配时保留规则推断）
 */
import { fetchRouteWithSegments } from '../src/route/amapRoute'
import { enrichSegmentsWithDem } from '../src/route/demFetch'
import { enrichSegmentsWithOsmRoads } from '../src/route/osmRoad'
import { enrichSegmentsWithWeather } from '../src/route/weather'
import { expectedStopCount, summarizeSegments } from '../src/route/segment'

const ROAD_LEVEL: Record<string, string> = { highway: '高速', national: '国道', provincial: '省道', expressway: '快速路', city: '市区', county: '县乡道', other: '其他' }
const TERRAIN: Record<string, string> = { plain: '平原', hilly: '微丘', heavyHilly: '重丘', mountain: '山岭' }
const TRAFFIC: Record<string, string> = { smooth: '畅通', slow: '缓行', congested: '拥堵', severe: '严重拥堵', unknown: '未知' }
const MOTION_LABEL: Record<string, string> = { cruise: '巡航', toll: '收费站', intersection: '路口', ramp: '匝道', turn: '转弯', serviceArea: '服务区', urbanStopStart: '城市起停' }

async function main() {
  const args = process.argv.slice(2)
  const origin = args[0] || '113.13,40.99'
  const destination = args[1] || '117.19,39.13'
  const index = Number(args[2] || 0)
  const departureTime = args[3] || undefined
  console.log('提取路段高程:', origin, '→', destination, '路线' + (index + 1))
  const { candidate, segments } = await fetchRouteWithSegments(origin, destination, index)
  console.log('候选路线:', candidate.distanceKm + 'km', candidate.durationH + 'h')
  console.log('下载 DEM 瓦片（首次较慢，之后走 data/dem-cache 缓存）…')
  const t0 = Date.now()
  const concurrency = Number(process.env.DEM_CONCURRENCY || 6)
  const enriched = await enrichSegmentsWithDem(segments, { cacheDir: 'data/dem-cache', concurrency })
  console.log('完成：源=' + enriched.source + '，瓦片=' + enriched.tilesUsed + '，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's')
  console.log('查询 OSM 真实路网（升级道路等级；首次较慢，之后走 data/osm-cache 缓存）…')
  const osm = await enrichSegmentsWithOsmRoads(enriched.segments, { cacheDir: 'data/osm-cache' })
  console.log('OSM 完成：请求 ' + osm.queries + ' 次，OSM 覆盖 ' + osm.osmCoveredKm.toFixed(1) + 'km / 兜底 ' + osm.ruleFallbackKm.toFixed(1) + 'km')
  console.log('抓取沿线天气（出发时间 ' + (departureTime || '当前时间') + '；QWeather 主源/高德兜底，未配置 key 自动跳过）…')
  const wx = await enrichSegmentsWithWeather(osm.segments, { cacheDir: 'data/weather-cache', departureTime })
  console.log('天气完成：源=' + wx.provider + ' 采样=' + wx.sampled + '段 请求=' + wx.queries + ' 大风段(≥阈值)=' + wx.windySegments + ' ' + JSON.stringify(wx.bySource))
  const sum = summarizeSegments(wx.segments)
  console.log('汇总:', JSON.stringify({
    总里程km: sum.totalKm, 平均坡度: sum.avgGradePercent, 平均海拔m: sum.avgElevationM,
    高速km: sum.roadLevelKm.highway, 国道km: sum.roadLevelKm.national, 省道km: sum.roadLevelKm.provincial,
    快速路km: sum.roadLevelKm.expressway, 市区km: sum.roadLevelKm.city, 县乡道km: sum.roadLevelKm.county, 其他km: sum.roadLevelKm.other,
  }))
  console.log('')
  console.log('路段 | 道路 | 等级(来源) | 里程km | 均速 | 坡度% | 海拔m | 地形 | 温度℃ | 风速km/h | 湿度% | 变速 | 期望停车 | 路况')
  const behaviorStat = new Map<string, { count: number; km: number; stops: number }>()
  for (const s of wx.segments) {
    const b = s.motionBehavior
    const cur = behaviorStat.get(b) ?? { count: 0, km: 0, stops: 0 }
    cur.count += 1
    cur.km += s.distanceKm
    cur.stops += expectedStopCount(s)
    behaviorStat.set(b, cur)
  }
  console.log('')
  console.log('行为汇总 | 段数 | 里程km | 期望停车/启停次数')
  for (const [b, v] of [...behaviorStat.entries()].sort((a, c) => c[1].count - a[1].count)) {
    console.log('  ' + MOTION_LABEL[b] + ' | ' + v.count + ' | ' + v.km.toFixed(1) + ' | ' + v.stops.toFixed(2))
  }
  console.log('')
  for (const s of wx.segments) {
    const src = s.roadSource === 'osm'
      ? 'OSM:' + (s.osmRef || s.osmHighway || '?')
      : '规则'
    console.log(
      [s.index, s.roadName || '-', ROAD_LEVEL[s.roadLevel] + '(' + src + ')', s.distanceKm, s.avgSpeedKmh,
        s.gradePercent ?? '-', s.elevationM ?? '-', s.terrain ? TERRAIN[s.terrain] : '-', s.temperatureC ?? '-', s.windSpeedKmh ?? '-', s.humidityPct ?? '-', MOTION_LABEL[s.motionBehavior], expectedStopCount(s), TRAFFIC[s.trafficStatus],
      ].join(' | '),
    )
  }
}

main().catch((e) => { console.error('运行失败:', e); process.exit(1) })
