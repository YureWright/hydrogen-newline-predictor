/** 路段切分算法验证：行为区检测 + 坡度自适应切分（纯函数，无需联网） */
import type { AmapRawPath, MotionBehavior, SegmentData } from '../src/route/types'
import {
  buildIntersectionEvents, buildSegments, detectMotionBehavior, expectedStopCount, maxHeadingChange,
} from '../src/route/segment'
import {
  mergeContinuationFragments, shouldSplitByGrade, splitGradeProfile, GRADE_BAND_PCT, MAX_SEGMENT_KM,
} from '../src/route/demFetch'
import type { ProfilePoint } from '../src/route/dem'

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

/**
 * 生成一条正南北向折线，几何长度 ≈ totalM（每 stepM 一个点）。
 * 真实高德 polyline 的几何长度与 step 声明 distance 偏差在 1% 内，夹具必须遵守这一点：
 * 若折线几何长度是声明里程的数倍，尾部事件段的长度就无从校验（旧夹具差 7 倍，
 * 拆出来的"1.5km 匝道段"实际有 8km，测试却照样通过）。
 */
function makePolyline(lng: number, lat0: number, totalM: number, stepM: number): string {
  const n = Math.max(1, Math.round(totalM / stepM))
  const dLat = stepM / 111194.9 // 1° 纬度 ≈ 111.19km（球面半径 6371km）
  const pts: string[] = []
  for (let i = 0; i <= n; i++) pts.push(lng.toFixed(6) + ',' + (lat0 + dLat * i).toFixed(6))
  return pts.join(';')
}

function seg(distanceKm: number, behavior: MotionBehavior = 'cruise', events: SegmentData['motionEvents'] = []): SegmentData {
  return {
    index: 0, roadName: 'G6京藏高速', roadLevel: behavior === 'urbanStopStart' ? 'city' : 'highway',
    distanceKm, avgSpeedKmh: 80, gradePercent: null, elevationM: null,
    trafficStatus: 'smooth', stopDensity: 0.02, motionBehavior: behavior, motionEvents: events,
    temperatureC: null, coordsWgs84: [[100, 30], [101, 30]], durationH: 0,
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
  const inter = detectMotionBehavior('直行通过红绿灯路口', 'city', [])
  assert('红绿灯停车 P=0.4', Math.abs((inter.events.find(e => e.type === 'stop')?.expectedCount ?? -1) - 0.4) < 1e-9)
  assert('城市一般路口 → intersection(P=0.35)', detectMotionBehavior('通过路口', 'city', []).behavior === 'intersection')
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
      {
        instruction: '沿S15京津高速途径XX桥向东南行驶10千米向右前方行驶进入匝道',
        distance: '10000', duration: '500', tolls: '20', toll_distance: '10000',
        polyline: makePolyline(117.0, 39.0, 10000, 250),
      },
    ],
  }
  const longSegs = buildSegments(longRamp)
  assert('长事件 step → 拆成 2 段', longSegs.length === 2, String(longSegs.length))
  assert('头部为巡航', longSegs[0].motionBehavior === 'cruise')
  assert('尾部为匝道', longSegs[1].motionBehavior === 'ramp')
  assert('事件只挂在尾部（一次计数）', longSegs[1].motionEvents.some(e => e.type === 'decel') && longSegs[0].motionEvents.length === 0)
  const kmSum = longSegs.reduce((a, s) => a + s.distanceKm, 0)
  assert('里程守恒（合计≈10km）', Math.abs(kmSum - 10) < 0.5, String(kmSum))
  assert('尾部事件段长度 = 匝道事件区 1.5km（不能吞掉主体段）',
    Math.abs(longSegs[1].distanceKm - 1.5) < 0.1, String(longSegs[1].distanceKm))
  assert('尾部匝道段均速 = 事件典型速度(35km/h)', Math.abs(longSegs[1].avgSpeedKmh - 35) < 0.1, String(longSegs[1].avgSpeedKmh))
  assert('头部均速 ≥ 整步均速（慢速事件区的时间已归给尾部）',
    longSegs[0].avgSpeedKmh >= 10000 / 1000 / (500 / 3600) - 0.1, String(longSegs[0].avgSpeedKmh))
  assert('尾部时长 = 尾部里程/事件速度（自洽）', Math.abs(longSegs[1].durationH - longSegs[1].distanceKm / 35) < 0.005, 'dur=' + longSegs[1].durationH + ' km=' + longSegs[1].distanceKm)
  const hSum = longSegs[0].durationH + longSegs[1].durationH
  assert('时长守恒（两段合计 = step 实测 500s）', Math.abs(hSum - 500 / 3600) < 1e-3,
    'sum=' + hSum.toFixed(4) + ' step=' + (500 / 3600).toFixed(4))

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
      {
        instruction: '沿京津快速途径XX桥向南行驶10千米右转',
        distance: '10000', duration: '1200', tolls: '0', toll_distance: '0',
        polyline: makePolyline(117.0, 39.0, 10000, 250),
      },
    ],
  }
  const cityTurnSegs = buildSegments(longCityTurn)
  assert('长城市转弯 step → 拆成 2 段', cityTurnSegs.length === 2, String(cityTurnSegs.length))
  assert('头部是城市起停（不再误判巡航）', cityTurnSegs[0].motionBehavior === 'urbanStopStart', String(cityTurnSegs[0].motionBehavior))
  assert('头部带红绿灯事件', cityTurnSegs[0].motionEvents.some(e => e.label === '红绿灯路口'))
  assert('尾部是转弯且带减速事件', cityTurnSegs[1].motionBehavior === 'turn' && cityTurnSegs[1].motionEvents.some(e => e.type === 'decel'))
  assert('头部红绿灯只按头部里程算（8.5km×3×0.35≈8.9）',
    Math.abs(cityTurnSegs[0].motionEvents.filter(e => e.label === '红绿灯路口').reduce((a, e) => a + e.expectedCount, 0)
      - cityTurnSegs[0].distanceKm * 3 * 0.35) < 0.05)

  console.log('— 路口计数：切分守恒 —')
  const sumExp = (evs: ReturnType<typeof buildIntersectionEvents>) => evs.reduce((a, e) => a + e.expectedCount, 0)
  const whole10 = sumExp(buildIntersectionEvents(10, 'national', 'smooth'))
  let split10 = 0
  for (let i = 0; i < 20; i++) split10 += sumExp(buildIntersectionEvents(0.5, 'national', 'smooth'))
  assert('10km 整段 = 切成 20×0.5km 的合计（地形切分不改变路口总数）',
    Math.abs(whole10 - split10) < 0.02, 'whole=' + whole10 + ' split=' + split10)
  assert('国道 10km 期望停车 = 10×0.4×0.35 = 1.4', Math.abs(whole10 - 1.4) < 0.02, String(whole10))
  let split1km = 0
  for (let i = 0; i < 10; i++) split1km += sumExp(buildIntersectionEvents(0.1, 'city', 'congested'))
  assert('城市 1km 整段 = 切成 10×0.1km 的合计',
    Math.abs(sumExp(buildIntersectionEvents(1, 'city', 'congested')) - split1km) < 0.02,
    'whole=' + sumExp(buildIntersectionEvents(1, 'city', 'congested')) + ' split=' + split1km)

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
