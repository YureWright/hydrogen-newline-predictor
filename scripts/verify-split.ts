/** 路段切分算法验证：行为区检测 + 坡度自适应切分（纯函数，无需联网） */
import type { MotionBehavior, SegmentData } from '../src/route/types'
import {
  detectMotionBehavior, expectedStopCount, maxHeadingChange,
} from '../src/route/segment'
import {
  mergeContinuationFragments, splitGradeProfile, GRADE_BAND_PCT, MAX_SEGMENT_KM,
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

  console.log(failed === 0 ? '\n✅ 全部通过' : '\n❌ ' + failed + ' 项失败')
  process.exit(failed === 0 ? 0 : 1)
}

main()
