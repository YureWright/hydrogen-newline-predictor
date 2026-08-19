/** 路段切分算法验证：行为区检测 + 坡度自适应切分（纯函数，无需联网） */
import type { AmapRawPath, MotionBehavior, SegmentData } from '../src/route/types'
import {
  buildIntersectionEvents, buildSegments, detectMotionBehavior, expectedStopCount,
  extractRoadName, inferRoadLevel, maxHeadingChange,
} from '../src/route/segment'
import {
  enrichWithTiles, mergeContinuationFragments, shouldSplitByGrade, splitGradeProfile,
  GRADE_BAND_PCT, MAX_SEGMENT_KM,
} from '../src/route/demFetch'
import { resampleCoords, type ProfilePoint } from '../src/route/dem'

let failed = 0
function assert(name: string, cond: boolean, detail?: string) {
  if (cond) console.log('  PASS', name)
  else { failed++; console.error('  FAIL', name, detail ?? '') }
}

/** 合成剖面：按 (长度km, 坡度%) 逐段生成 200m 采样点 */
function profile(segments: Array<{ lenKm: number; gradePct: number }>): { pts: ProfilePoint[]; elevs: number[] } {
  const pts: ProfilePoint[] = []
  const elevs: number[] = []
  let cum = 0
  let elev = 0
  pts.push({ lng: 100, lat: 30, cumM: 0 })
  elevs.push(elev)
  for (const s of segments) {
    const n = Math.max(1, Math.round((s.lenKm * 1000) / 200))
    for (let i = 1; i <= n; i++) {
      cum += 200
      elev += 200 * (s.gradePct / 100)
      pts.push({ lng: 100 + cum / 100000, lat: 30, cumM: cum })
      elevs.push(elev)
    }
  }
  return { pts, elevs }
}

/** 每片是否单调（只上坡或只下坡，允许 ±0.2m/200m 噪声） */
function isMonotonic(pts: ProfilePoint[], elevs: number[]): boolean {
  let up = 0
  let down = 0
  for (let i = 1; i < pts.length; i++) {
    const d = elevs[i] - elevs[i - 1]
    if (d > 0.2) up++
    else if (d < -0.2) down++
  }
  return up === 0 || down === 0
}

/** 片内坡度范围（%） */
function gradeRange(pts: ProfilePoint[], elevs: number[]): number {
  const gs: number[] = []
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i].cumM - pts[i - 1].cumM
    if (d > 0) gs.push(((elevs[i] - elevs[i - 1]) / d) * 100)
  }
  if (!gs.length) return 0
  return Math.max(...gs) - Math.min(...gs)
}

function seg(distanceKm: number, behavior: MotionBehavior = 'cruise', events: SegmentData['motionEvents'] = []): SegmentData {
  return {
    index: 0, roadName: 'G6京藏高速', roadLevel: behavior === 'urbanStopStart' ? 'city' : 'highway',
    distanceKm, avgSpeedKmh: 80, gradePercent: null, elevationM: null,
    trafficStatus: 'smooth', stopDensity: 0.02, motionBehavior: behavior, motionEvents: events,
    temperatureC: null, coordsWgs84: [[100, 30], [101, 30]], durationH: 0,
  }
}

/** 单 step 的城市路线夹具：直线折线（不触发几何转弯）+ 畅通路况 */
function cityPath(instruction: string, distanceM: number): AmapRawPath {
  const d = String(distanceM)
  return {
    distance: d, duration: '600', tolls: '0', toll_distance: '0',
    steps: [{
      instruction, distance: d, duration: '600', tolls: '0', toll_distance: '0',
      polyline: '116.40,39.90;116.40,39.92;116.40,39.94',
      tmcs: [{ status: '畅通', distance: d, polyline: '' }],
    }],
  }
}

function main() {
  console.log('=== 路段切分算法 · 纯函数自测 ===')

  console.log('— 行为区检测 —')
  assert('收费站(ETC) → toll', detectMotionBehavior('进入收费站', 'highway', []).behavior === 'toll')
  assert('收费站(ETC) 停车 P=0.1',
    Math.abs((detectMotionBehavior('进入收费站', 'highway', []).events.find(e => e.type === 'stop')?.expectedCount ?? -1) - 0.1) < 1e-9)
  assert('收费站(人工) 停车 P=0.95',
    Math.abs((detectMotionBehavior('前方人工收费车道', 'highway', []).events.find(e => e.type === 'stop')?.expectedCount ?? -1) - 0.95) < 1e-9)
  assert('服务区 → serviceArea', detectMotionBehavior('进入服务区', 'highway', []).behavior === 'serviceArea')
  assert('匝道 → ramp', detectMotionBehavior('靠右前方行驶进入G6京藏高速', 'highway', []).behavior === 'ramp')
  assert('驶出高速 → ramp', detectMotionBehavior('驶出G6京藏高速', 'highway', []).behavior === 'ramp')
  assert('分叉口保持主路(靠右前方) → 不再误判匝道', detectMotionBehavior('靠右前方行驶，保持G6京藏高速', 'highway', []).behavior === 'cruise')
  assert('分叉口保持主路(向右前方) → 不再误判匝道', detectMotionBehavior('向右前方行驶，保持主路', 'highway', []).behavior === 'cruise')
  assert('进入城区(含"进入") → 不误判匝道', detectMotionBehavior('进入天津市区', 'city', []).behavior === 'urbanStopStart')
  assert('红绿灯路口 → intersection', detectMotionBehavior('直行通过红绿灯路口', 'city', []).behavior === 'intersection')
  const inter = detectMotionBehavior('直行通过红绿灯路口', 'city', [], 'smooth')
  assert('红绿灯停车概率随路况（畅通 P=0.35）',
    Math.abs((inter.events.find(e => e.type === 'stop')?.expectedCount ?? -1) - 0.35) < 1e-9)
  const interJam = detectMotionBehavior('直行通过红绿灯路口', 'city', [], 'congested')
  assert('红绿灯停车概率随路况（拥堵 P=0.8）',
    Math.abs((interJam.events.find(e => e.type === 'stop')?.expectedCount ?? -1) - 0.8) < 1e-9)
  assert('城市一般路口 → intersection', detectMotionBehavior('通过路口', 'city', []).behavior === 'intersection')
  assert('高速上的红绿灯关键词不产生停车（高速无平面路口）',
    !detectMotionBehavior('直行通过红绿灯路口', 'highway', [], 'smooth').events.some(e => e.type === 'stop'))
  assert('左转 → turn', detectMotionBehavior('左转进入幸福路', 'city', []).behavior === 'turn')
  assert('掉头 → turn(带停车)', (detectMotionBehavior('掉头', 'city', []).events.find(e => e.type === 'stop')?.expectedCount ?? 0) > 0)
  assert('城市兜底 → urbanStopStart', detectMotionBehavior('沿幸福路行驶', 'city', []).behavior === 'urbanStopStart')
  assert('高速巡航 → cruise', detectMotionBehavior('沿G6京藏高速行驶', 'highway', []).behavior === 'cruise')

  console.log('— 几何转弯检测 —')
  assert('直行折线 航向变化≈0', maxHeadingChange([[100, 30], [100.1, 30], [100.2, 30]]) < 5)
  const corner = maxHeadingChange([[100, 30], [100.1, 30], [100.1, 30.1]])
  assert('90° 拐角 航向变化≈90', Math.abs(corner - 90) < 3, String(corner))
  assert('几何急弯(>40°) → turn', detectMotionBehavior('', 'highway', [[100, 30], [100.1, 30], [100.1, 30.1]]).behavior === 'turn')

  console.log('— 期望停车次数 —')
  const tollSeg = seg(0.5, 'toll', [{ type: 'stop', expectedCount: 0.1, probability: 0.1, label: 'ETC收费站' }])
  assert('事件段：取事件期望次数', Math.abs(expectedStopCount(tollSeg) - 0.1) < 1e-9)
  const cruiseSeg = seg(50)
  assert('巡航段：按密度折算 = 0.02×50 = 1', Math.abs(expectedStopCount(cruiseSeg) - 1) < 1e-9)

  console.log('— 行为感知合并 —')
  const merged = mergeContinuationFragments([
    seg(30), // 巡航 30km
    seg(0.1), // 同路巡航碎段 → 并入
    seg(0.3, 'toll', [{ type: 'stop', expectedCount: 0.1, probability: 0.1, label: '收费站' }]), // 事件段 → 保留
  ])
  assert('同路无事件碎段被并入', merged.length === 2 && Math.abs(merged[0].distanceKm - 30.1) < 1e-6, String(merged.map(s => s.distanceKm)))
  assert('收费站事件段保留', merged[1].motionBehavior === 'toll')

  console.log('— 坡度自适应切分 —')
  // ① 平路 5km → 1 片
  let r = profile([{ lenKm: 5, gradePct: 0 }])
  let slices = splitGradeProfile(r.pts, r.elevs)
  assert('平路 5km → 1 片', slices.length === 1, String(slices.length))

  // ② 先上后下（2% 爬 5km → 2% 下 5km）→ ≥2 片且每片单调
  r = profile([{ lenKm: 5, gradePct: 2 }, { lenKm: 5, gradePct: -2 }])
  slices = splitGradeProfile(r.pts, r.elevs)
  assert('上坡+下坡 10km → ≥2 片', slices.length >= 2, String(slices.length))
  assert('每片单调（只上或只下）', slices.every(s => isMonotonic(s.pts, s.elevs)))

  // ③ 0→6% 缓变坡（10km）→ 多片且每片坡度范围受控
  const ramp: Array<{ lenKm: number; gradePct: number }> = []
  for (let k = 0; k < 20; k++) ramp.push({ lenKm: 0.5, gradePct: (k / 20) * 6 })
  r = profile(ramp)
  slices = splitGradeProfile(r.pts, r.elevs)
  assert('0→6% 缓变坡 → 多片', slices.length >= 2, String(slices.length))
  assert('每片坡度范围 ≤ 坡度带+容差',
    slices.every(s => gradeRange(s.pts, s.elevs) <= GRADE_BAND_PCT + 1.5),
    slices.map(s => gradeRange(s.pts, s.elevs).toFixed(2)).join(','))

  // ④ 30km 平路 → 长度上限切分，每片 ≤ 10km+容差
  r = profile([{ lenKm: 30, gradePct: 0 }])
  slices = splitGradeProfile(r.pts, r.elevs)
  assert('30km 平路 → ≥3 片', slices.length >= 3, String(slices.length))
  const lens = slices.map(s => (s.pts[s.pts.length - 1].cumM - s.pts[0].cumM) / 1000)
  assert('每片长度 ≤ 10km + 0.2 容差', lens.every(L => L <= MAX_SEGMENT_KM + 0.2), lens.map(L => L.toFixed(2)).join(','))

  // ⑤ 短段（0.5km）不参与地形切分
  r = profile([{ lenKm: 0.5, gradePct: 3 }])
  slices = splitGradeProfile(r.pts, r.elevs)
  assert('0.5km 短段 → 1 片（不切分）', slices.length === 1, String(slices.length))

  console.log('— 同一事件区合并计数（buildSegments） —')
  const tollRun: AmapRawPath = {
    distance: '3000', duration: '300', tolls: '10', toll_distance: '3000',
    steps: [
      { instruction: '进入收费站', distance: '1500', duration: '150', tolls: '5', toll_distance: '1500', polyline: '113.1,40.9;113.2,40.9;113.3,40.9' },
      { instruction: '驶出收费站', distance: '1500', duration: '150', tolls: '5', toll_distance: '1500', polyline: '113.3,40.9;113.4,40.9;113.5,40.9' },
    ],
  }
  const tollSegs = buildSegments(tollRun)
  assert('连续收费站 step → 合并成 1 段（同一广场）', tollSegs.length === 1, String(tollSegs.length))
  assert('合并后为 toll 且带变速事件', tollSegs[0].motionBehavior === 'toll' && tollSegs[0].motionEvents.some(e => e.type === 'stop'))
  assert('合并后里程守恒（≈3km）', Math.abs(tollSegs[0].distanceKm - 3) < 0.1, String(tollSegs[0].distanceKm))
  assert('合并后全段期望停车 = 0.1（一座广场只计一次）', Math.abs(expectedStopCount(tollSegs[0]) - 0.1) < 1e-9)

  console.log('— 长事件 step 拆分（尾部事件段） —')
  const longRamp: AmapRawPath = {
    distance: '10000', duration: '500', tolls: '20', toll_distance: '10000',
    steps: [
      { instruction: '沿S15京津高速途径XX桥向东南行驶10千米向右前方行驶进入匝道', distance: '10000', duration: '500', tolls: '20', toll_distance: '10000', polyline: '117.0,39.0;117.1,39.1;117.2,39.2;117.3,39.3;117.4,39.4;117.5,39.5' },
    ],
  }
  const longSegs = buildSegments(longRamp)
  assert('长事件 step → 拆成 2 段', longSegs.length === 2, String(longSegs.length))
  assert('头部为巡航', longSegs[0].motionBehavior === 'cruise')
  assert('尾部为匝道', longSegs[1].motionBehavior === 'ramp')
  assert('事件只挂在尾部（一次计数）', longSegs[1].motionEvents.some(e => e.type === 'decel') && longSegs[0].motionEvents.length === 0)
  const kmSum = longSegs.reduce((a, s) => a + s.distanceKm, 0)
  assert('里程守恒（合计≈10km）', Math.abs(kmSum - 10) < 0.5, String(kmSum))
  assert('尾部匝道段均速 = 事件典型速度(35km/h)', Math.abs(longSegs[1].avgSpeedKmh - 35) < 0.1, String(longSegs[1].avgSpeedKmh))
  assert('头部巡航段均速 = 整步均速', longSegs[0].avgSpeedKmh > 35, String(longSegs[0].avgSpeedKmh))
  assert('尾部时长 = 尾部里程/事件速度（自洽）', Math.abs(longSegs[1].durationH - longSegs[1].distanceKm / 35) < 0.005, 'dur=' + longSegs[1].durationH + ' km=' + longSegs[1].distanceKm)

  console.log('— 城市红绿灯事件 —')
  const cityRun: AmapRawPath = {
    distance: '2000', duration: '400', tolls: '0', toll_distance: '0',
    steps: [
      { instruction: '沿幸福大街向南行驶2公里', distance: '2000', duration: '400', tolls: '0', toll_distance: '0', polyline: '116.0,39.9;116.0,39.95;116.0,40.0' },
    ],
  }
  const citySegs = buildSegments(cityRun)
  assert('城市 step → urbanStopStart', citySegs[0].motionBehavior === 'urbanStopStart')
  assert('城市 step 挂红绿灯事件', citySegs[0].motionEvents.some(e => e.label === '红绿灯路口' && e.type === 'stop'))
  const expCity = citySegs[0].motionEvents.filter(e => e.type === 'stop').reduce((a, e) => a + e.expectedCount, 0)
  assert('城市期望停车 = 路口数×P（2km×3路口/km×0.35≈2.1）', Math.abs(expCity - 2.1) < 0.05, String(expCity))
  assert('expectedStopCount 用红绿灯事件', Math.abs(expectedStopCount(citySegs[0]) - expCity) < 1e-9)

  console.log('— 长城市转弯 step 拆分（头部恢复城市起停） —')
  const longCityTurn: AmapRawPath = {
    distance: '10000', duration: '1200', tolls: '0', toll_distance: '0',
    steps: [
      { instruction: '沿京津大街途径XX桥向南行驶10千米右转', distance: '10000', duration: '1200', tolls: '0', toll_distance: '0', polyline: '117.00,39.0;117.01,39.0;117.02,39.0;117.03,39.0;117.04,39.0;117.05,39.0;117.06,39.0;117.07,39.0;117.08,39.0;117.09,39.0;117.10,39.0;117.11,39.0;117.12,39.0;117.13,39.0;117.14,39.0' },
    ],
  }
  const cityTurnSegs = buildSegments(longCityTurn)
  assert('长城市转弯 step → 拆成 2 段', cityTurnSegs.length === 2, String(cityTurnSegs.length))
  assert('头部是城市起停（不再误判巡航）', cityTurnSegs[0].motionBehavior === 'urbanStopStart', String(cityTurnSegs[0].motionBehavior))
  assert('头部带红绿灯事件', cityTurnSegs[0].motionEvents.some(e => e.label === '红绿灯路口'))
  assert('尾部是转弯且带减速事件', cityTurnSegs[1].motionBehavior === 'turn' && cityTurnSegs[1].motionEvents.some(e => e.type === 'decel'))

  console.log('— 真实高德指令形状：城区转向段仍要计启停 —')
  // 高德城市导航指令绝大多数以"左转/右转进入 XX 路"结尾，此前这类段期望停车恒为 0
  const cityTurn = buildSegments(cityPath('沿幸福大街向南行驶800米，右转进入建设路', 800))
  const cityStraight = buildSegments(cityPath('沿幸福大街向南行驶800米', 800))
  assert('城区右转段 → turn', cityTurn[0].motionBehavior === 'turn', cityTurn[0].motionBehavior)
  assert('城区右转段期望停车 > 0（不再被算成 0 次）',
    expectedStopCount(cityTurn[0]) > 0, String(expectedStopCount(cityTurn[0])))
  assert('带转向与不带转向的同段期望停车量级一致（差 < 20%）',
    Math.abs(expectedStopCount(cityTurn[0]) - expectedStopCount(cityStraight[0])) / expectedStopCount(cityStraight[0]) < 0.2,
    `turn=${expectedStopCount(cityTurn[0])} straight=${expectedStopCount(cityStraight[0])}`)
  const hwyTurn = detectMotionBehavior('向右前方行驶', 'highway', [[100, 30], [100.1, 30], [100.1, 30.1]], 'smooth')
  assert('高速几何弯道不产生停车', !hwyTurn.events.some(e => e.type === 'stop'))

  console.log('— 关键词法与密度法同口径 —')
  const withKw = buildSegments(cityPath('沿建设大街向东行驶5公里，直行通过红绿灯路口', 5000))
  const withoutKw = buildSegments(cityPath('沿建设大街向东行驶5公里', 5000))
  const kwStops = withKw.reduce((a, s) => a + expectedStopCount(s), 0)
  const noKwStops = withoutKw.reduce((a, s) => a + expectedStopCount(s), 0)
  assert('5km 城市段：指令含/不含"红绿灯"期望停车一致（差 < 5%）',
    Math.abs(kwStops - noKwStops) / noKwStops < 0.05, `含=${kwStops} 不含=${noKwStops}`)

  console.log('— 切分不变性：切成几段不影响启停总数 —')
  const whole = buildIntersectionEvents(3, 'city', 'smooth')[0].expectedCount
  const inSix = Array.from({ length: 6 }, () => buildIntersectionEvents(0.5, 'city', 'smooth')[0].expectedCount)
    .reduce((a, b) => a + b, 0)
  // 残差只来自每条事件各自保留两位小数，不再是"每段至少一个路口"那种系统性放大
  assert('3km 整段 vs 切成 6×0.5km，期望停车一致（仅剩两位小数舍入残差）',
    Math.abs(whole - inSix) < 0.05, `整段=${whole} 六段=${inSix}`)
  assert('不足一个路口的短段不再被抬成一整个路口',
    buildIntersectionEvents(0.1, 'city', 'smooth')[0].expectedCount < 0.2,
    String(buildIntersectionEvents(0.1, 'city', 'smooth')[0].expectedCount))

  console.log('— 高程缺失时坡度必须是 null，不能是 0 —')
  const demSeg: SegmentData = { ...seg(4, 'cruise'), coordsWgs84: [[100, 30], [100.02, 30], [100.04, 30]] }
  const noDem = enrichWithTiles([demSeg], new Map(), 14)
  assert('无瓦片 → gradePercent = null（不是 0）', noDem.every(s => s.gradePercent === null),
    JSON.stringify(noDem.map(s => s.gradePercent)))
  assert('无瓦片 → elevationM = null', noDem.every(s => s.elevationM === null))
  assert('无瓦片 → 剖面海拔全为 null（不画成 0 米）',
    noDem.every(s => (s.profile?.elevM ?? []).every(v => v === null)))

  console.log('— 剖面采样覆盖整段（不丢尾巴） —')
  // 500m 的段、200m 步长：取点应覆盖到 500m 处，而不是停在 400m
  const tail = resampleCoords([[116.0, 39.9], [116.0, 39.9045]], 200)
  const tailTotal = tail[tail.length - 1].cumM
  assert('末点累计里程 ≈ 段长（尾段进入坡度计算）', tailTotal > 495 && tailTotal < 505, String(tailTotal))

  console.log('— 道路等级与道路名 —')
  assert('G110（3 位编号）→ 国道', inferRoadLevel('G110', '沿G110行驶') === 'national')
  assert('G6（1 位编号）→ 高速', inferRoadLevel('G6', '沿G6行驶') === 'highway')
  assert('G4501（4 位编号）→ 高速', inferRoadLevel('G4501', '沿G4501行驶') === 'highway')
  assert('道路名去掉方向后缀', extractRoadName('沿幸福大街向南行驶800米') === '幸福大街',
    extractRoadName('沿幸福大街向南行驶800米'))
  assert('道路名支持"进入 XX 路"', extractRoadName('右转进入建设路') === '建设路',
    extractRoadName('右转进入建设路'))

  console.log('— 事件段不参与地形切分 —')
  assert('cruise 参与切分', shouldSplitByGrade('cruise') === true)
  assert('urbanStopStart 参与切分', shouldSplitByGrade('urbanStopStart') === true)
  assert('toll 不切分', shouldSplitByGrade('toll') === false)
  assert('ramp 不切分', shouldSplitByGrade('ramp') === false)
  assert('intersection 不切分', shouldSplitByGrade('intersection') === false)
  assert('turn 不切分', shouldSplitByGrade('turn') === false)
  assert('serviceArea 不切分', shouldSplitByGrade('serviceArea') === false)

  console.log(failed === 0 ? '\n✅ 全部通过' : '\n❌ ' + failed + ' 项失败')
  process.exit(failed === 0 ? 0 : 1)
}

main()
