/**
 * 试水版：偏好驱动的「路线 + 分段车速」联合优化（氢耗用物理模型）
 *
 * 做法：
 *   1) 取高德候选路线（默认 3 条），逐条分段 + DEM 高程（得到坡度/海拔）
 *   2) 每段在可行车速区间内扫描（默认 30~90 km/h，步长 5）
 *   3) 用 ml/physics.py 批量计算每个「段 × 车速」的氢耗
 *   4) 给定时间价值 λ（元/h），每段选广义成本最小的车速
 *   5) 汇总每条路线的费用/时间，选最优；扫描 λ 得到 Pareto 前沿
 *
 * 用法：
 *   npx tsx scripts/optimize_trial.ts "武汉市" "恩施野三关"
 *   npx tsx scripts/optimize_trial.ts "114.30,30.59" "110.32,30.61"
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

// ---- 读取 .env ----
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim()
}
const AMAP_KEY = process.env.AMAP_KEY
if (!AMAP_KEY) throw new Error('缺少 AMAP_KEY')

const { fetchRoutePlan, fetchRouteWithSegments } = await import('../src/route/amapRoute')
const { enrichSegmentsWithDem } = await import('../src/route/demFetch')
const { TRUCK_SPEED_MAX } = await import('../src/route/segment')

// ---- 参数 ----
const COST = {
  h2Price: 35,     // 元/kg
  driverRate: 60,  // 元/h
  otherPerKm: 0.5, // 元/km
}
// H49 官方参数（风阻按官网 0.27）
const VEHICLE = {
  massKg: 49000,
  crr: 0.009,
  cd: 0.27,
  frontArea: 7.5,
  etaMt: 0.9,
  pFcMin: 30,
  pFcMax: 180,
  pBatMax: 150,
  etaFc: 0.5,
  pAux0: 3.0,
  kT: 0.15,
}
const SPEEDS = [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90]
const LAMBDAS = [0, 50, 100, 200, 300, 400, 500, 700, 1000] // 时间价值 元/h

const log = (...a: any[]) => console.log('[optimize]', ...a)

async function geocode(addr: string): Promise<string> {
  if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(addr.trim())) return addr.trim()
  const url = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(addr)}&key=${AMAP_KEY}`
  const r = await fetch(url)
  const j: any = await r.json()
  const loc = j?.geocodes?.[0]?.location
  if (!loc) throw new Error('地理编码失败: ' + addr)
  return loc
}

function runPhysics(segments: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
    const child = spawn(py, ['physics.py'], { cwd: path.join(ROOT, 'ml') })
    let out = '', err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('close', () => {
      try {
        const j = JSON.parse(out)
        if (!j.ok) return reject(new Error(j.msg || 'physics.py 失败'))
        resolve(j.segments)
      } catch (e) {
        reject(new Error('physics 解析失败: ' + err.slice(0, 300)))
      }
    })
    child.stdin.write(JSON.stringify({ departure_hour: 9, segments }))
    child.stdin.end()
  })
}

async function main() {
  const originArg = process.argv[2] || '武汉市'
  const destArg = process.argv[3] || '恩施野三关'

  const origin = await geocode(originArg)
  const destination = await geocode(destArg)
  log('起点', origin, '→ 终点', destination)

  const plan = await fetchRoutePlan(origin, destination)
  const candidates = plan.routes.slice(0, 3)
  log('候选路线', candidates.length, '条：', candidates.map((c) => c.distanceKm + 'km').join(' / '))

  // 1) 逐条分段 + DEM
  const routes: Array<{ candidate: any; segments: any[] }> = []
  for (let i = 0; i < candidates.length; i++) {
    log(`路线 ${i + 1}: 分段 + DEM 高程...`)
    const { candidate, segments } = await fetchRouteWithSegments(origin, destination, i)
    const dem = await enrichSegmentsWithDem(segments, {
      cacheDir: path.join(ROOT, 'data', 'dem-cache'),
    })
    routes.push({ candidate, segments: dem.segments })
    log(`  路线 ${i + 1}: ${candidate.distanceKm}km, ${dem.segments.length} 段`)
  }

  // 2) 构造「段 × 车速」批量请求
  const batch: any[] = []
  const meta: Array<{ route: number; seg: number; v: number }> = []
  routes.forEach((r, ri) => {
    r.segments.forEach((s, si) => {
      const level = String(s.roadLevel || 'other') as any
      const cap = Math.min(TRUCK_SPEED_MAX[level] ?? 80, Math.max(s.avgSpeedKmh * 1.1, 40))
      SPEEDS.filter((v) => v <= cap).forEach((v) => {
        batch.push({
          distanceKm: s.distanceKm,
          avgSpeedKmh: v,
          gradePercent: s.gradePercent,
          elevationM: s.elevationM,
          temperatureC: s.temperatureC ?? 20,
          massKg: VEHICLE.massKg,
          windSpeedKmh: s.windSpeedKmh ?? 0,
          windAffects: false,
          roadLevel: level,
          crr: VEHICLE.crr,
          cd: VEHICLE.cd,
          frontArea: VEHICLE.frontArea,
          eta_mt: VEHICLE.etaMt,
          p_fc_min: VEHICLE.pFcMin,
          p_fc_max: VEHICLE.pFcMax,
          p_bat_max: VEHICLE.pBatMax,
          eta_fc: VEHICLE.etaFc,
          p_aux0: VEHICLE.pAux0,
          k_t: VEHICLE.kT,
        })
        meta.push({ route: ri, seg: si, v })
      })
    })
  })
  log(`批量物理仿真：${batch.length} 个「段×车速」组合...`)
  const results = await runPhysics(batch)
  log('物理仿真完成')

  // 3) 按 λ 求解最优车速与路线
  const pareto: Array<{ lambda: number; route: number; cost: number; timeH: number; h2Kg: number; chosen: number[] }> = []
  const routeDetail: any[] = []

  for (const lambda of LAMBDAS) {
    let best: any = null
    routes.forEach((r, ri) => {
      // 每段先收集候选车速的成本
      const perSeg: Array<Array<{ v: number; h2Per100: number; cost: number }>> = r.segments.map(() => [])
      meta.forEach((m, k) => {
        if (m.route !== ri) return
        const res = results[k]
        if (!res || res.h2_per_km_kg == null) return
        const seg = r.segments[m.seg]
        const h2Per100 = res.h2_per_km_kg * 100
        const h2Cost = res.h2_per_km_kg * seg.distanceKm * COST.h2Price
        const timeCost = (COST.driverRate + lambda) * (seg.distanceKm / m.v)
        perSeg[m.seg].push({ v: m.v, h2Per100, cost: h2Cost + timeCost })
      })
      let h2Kg = 0, timeH = 0, chosen: number[] = []
      let feasible = true
      perSeg.forEach((opts, si) => {
        if (!opts.length) { feasible = false; return }
        const bestOpt = opts.reduce((a, b) => (b.cost < a.cost ? b : a))
        const seg = r.segments[si]
        h2Kg += bestOpt.h2Per100 / 100 * seg.distanceKm
        timeH += seg.distanceKm / bestOpt.v
        chosen.push(bestOpt.v)
      })
      if (!feasible) return
      const h2Yuan = h2Kg * COST.h2Price
      const toll = r.candidate.tollsYuan || 0
      const driver = timeH * COST.driverRate
      const other = r.candidate.distanceKm * COST.otherPerKm
      // 广义总成本：含时间价值 λ×T，偏好才能影响路线选择
      const total = h2Yuan + toll + driver + other + lambda * timeH
      const rec = { route: ri, cost: total, timeH, h2Kg, chosen, h2Yuan, toll, driver, other }
      if (!best || rec.cost < best.cost) best = rec
      if (lambda === 100) routeDetail.push({ ...rec, distanceKm: r.candidate.distanceKm })
    })
    if (best) pareto.push({ lambda, route: best.route, cost: best.cost, timeH: best.timeH, h2Kg: best.h2Kg, chosen: best.chosen })
  }

  // 4) 打印结果
  console.log('\n===== 各路线对比（λ=100 元/h，时间与费用均衡）=====')
  console.log('路线  里程km   总时长h   总氢耗kg  百公里kg/100km  氢费元  过路费元  司机费元  其他元  总费用元')
  routeDetail
    .sort((a, b) => a.cost - b.cost)
    .forEach((r) => {
      const c = routes[r.route].candidate
      console.log(
        `  ${r.route + 1}   ${c.distanceKm.toFixed(1).padStart(6)}   ${r.timeH.toFixed(2).padStart(6)}   ` +
        `${r.h2Kg.toFixed(2).padStart(7)}   ${((r.h2Kg / c.distanceKm) * 100).toFixed(2).padStart(10)}   ` +
        `${r.h2Yuan.toFixed(0).padStart(6)}   ${r.toll.toFixed(0).padStart(7)}   ${r.driver.toFixed(0).padStart(7)}   ` +
        `${r.other.toFixed(0).padStart(5)}   ${r.cost.toFixed(0).padStart(7)}`
      )
    })

  console.log('\n===== Pareto 前沿（时间价值 λ 扫描）=====')
  console.log(' λ(元/h)  选择路线   总费用元   总时长h   总氢耗kg')
  pareto.forEach((p) => {
    console.log(`  ${String(p.lambda).padStart(5)}     路线${p.route + 1}     ${p.cost.toFixed(2).padStart(8)}    ${p.timeH.toFixed(3).padStart(7)}    ${p.h2Kg.toFixed(2).padStart(7)}`)
  })

  // 车速随偏好变化（对比最省钱 vs 最赶时间）
  const counter = (arr: number[]) => {
    const m = new Map<number, number>()
    arr.forEach((v) => m.set(v, (m.get(v) || 0) + 1))
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([v, n]) => `${v}km/h×${n}`).join(' ')
  }
  const first = pareto[0]
  const last = pareto[pareto.length - 1]
  console.log('\n===== 车速随偏好变化（以最优路线为例）=====')
  console.log(`  λ=${first.lambda}（最省钱）: ${counter(first.chosen)}`)
  console.log(`  λ=${last.lambda}（最赶时间）: ${counter(last.chosen)}`)

  // 5) 输出 JSON 供前端/报告使用
  const outDir = path.join(ROOT, 'output')
  fs.mkdirSync(outDir, { recursive: true })
  const outPath = path.join(outDir, 'optimize_trial.json')
  fs.writeFileSync(outPath, JSON.stringify({
    origin, destination,
    vehicle: VEHICLE,
    cost: COST,
    routes: routes.map((r, i) => ({ index: i, candidate: r.candidate, segments: r.segments.length })),
    pareto,
    detailAt100: routeDetail,
  }, null, 2))
  log('结果已保存:', outPath)
}

main().catch((e) => {
  console.error('[optimize] 失败:', e?.message || e)
  process.exit(1)
})
