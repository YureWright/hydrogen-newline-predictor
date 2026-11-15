/**
 * 动态规划核心：路线 + 车速 + 氢电双补能 DP（考虑天气/路况）
 *
 * 流程：
 *   1) 高德路线 → 分段 → DEM 高程 → 沿线天气（温度/风速/湿度）
 *   2) 逐段车速扫描（物理模型）→ 每段最优车速与电耗/氢耗
 *   3) 匹配路线走廊内的加氢站（571座）与充电站（65,199座）
 *   4) 双补能 DP：状态(站点, 剩余氢, SOC) → 最小广义成本（含时间价值 λ）
 *   5) 输出 JSON（供报告页使用）
 *
 * 用法：
 *   npx tsx scripts/dynamic_plan.ts "武汉市" "恩施野三关" --lambda 100
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim()
}
const AMAP_KEY = process.env.AMAP_KEY
if (!AMAP_KEY) throw new Error('缺少 AMAP_KEY')

const { fetchRouteWithSegments } = await import('../src/route/amapRoute')
const { enrichSegmentsWithDem } = await import('../src/route/demFetch')
const { enrichSegmentsWithWeather } = await import('../src/route/weather')
const { TRUCK_SPEED_MAX } = await import('../src/route/segment')

// ---------- 车辆与成本参数 ----------
const V = {
  massKg: 49000, crr: 0.009, cd: 0.27, frontArea: 7.5, etaMt: 0.9,
  pFcMin: 30, pFcMax: 180, pBatMax: 150, etaFc: 0.5, pAux0: 3.0, kT: 0.15,
  h2CapacityKg: 50,        // 49t 车型 35MPa 6×390L ≈ 56/50kg
  batCapacityKWh: 155,     // 官方 155kWh
  socMin: 10, socMax: 90,  // 可用 SOC 窗口
  chargePowerKW: 120,      // 假设快充功率
  chargePlugH: 0.15,       // 插枪/结算时间
}
const COST = { h2Price: 35, elecPrice: 1.2, driverRate: 60, otherPerKm: 0.5 }
const LAMBDA = Number(process.argv.find((a) => a.startsWith('--lambda'))?.split('=')[1] ?? 100)
const OUT_ARG = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] || 'output/dynamic_plan.json'

const SPEEDS = [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90]
const log = (...a: any[]) => console.log('[plan]', ...a)

// ---------- 工具 ----------
async function geocode(addr: string): Promise<string> {
  if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(addr.trim())) return addr.trim()
  const url = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(addr)}&key=${AMAP_KEY}`
  const j: any = await (await fetch(url)).json()
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
        if (!j.ok) return reject(new Error(j.msg || 'physics 失败'))
        resolve(j.segments)
      } catch {
        reject(new Error('physics 解析失败: ' + err.slice(0, 300)))
      }
    })
    child.stdin.write(JSON.stringify({ departure_hour: 9, segments }))
    child.stdin.end()
  })
}

function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371, p1 = a[1] * Math.PI / 180, p2 = b[1] * Math.PI / 180
  const dp = p2 - p1, dl = (b[0] - a[0]) * Math.PI / 180
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

const round1 = (n: number) => Math.round(n * 10) / 10
const round2 = (n: number) => Math.round(n * 100) / 100

/** 点到折线的最近距离 + 折线累计里程位置 */
function projectToPolyline(pt: [number, number], poly: Array<[number, number]>, cum: number[]) {
  let best = { dist: Infinity, s: 0 }
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1]
    // 以经纬度近似平面投影
    const ax = a[0], ay = a[1], bx = b[0], by = b[1]
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    let t = len2 > 0 ? ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    const px = ax + t * dx, py = ay + t * dy
    const d = haversine([pt[0], pt[1]], [px, py])
    if (d < best.dist) {
      best = { dist: d, s: cum[i] + t * (cum[i + 1] - cum[i]) }
    }
  }
  return best
}

// ---------- 主流程 ----------
async function main() {
  const originArg = process.argv[2] || '武汉市'
  const destArg = process.argv[3] || '恩施野三关'
  const origin = await geocode(originArg)
  const destination = await geocode(destArg)
  log('路线', originArg, '→', destArg, '| λ =', LAMBDA, '元/h')

  // 1) 路线与分段
  const { candidate, segments } = await fetchRouteWithSegments(origin, destination, 0)
  log(`分段 ${segments.length} 段，共 ${candidate.distanceKm}km`)

  // 2) DEM + 天气
  log('DEM 高程...')
  const dem = await enrichSegmentsWithDem(segments, { cacheDir: path.join(ROOT, 'data', 'dem-cache') })
  log('沿线天气...')
  const wx = await enrichSegmentsWithWeather(dem.segments, {
    cacheDir: path.join(ROOT, 'data', 'weather-cache'),
    departureTime: new Date().toISOString(),
  })
  const segs = wx.segments
  log(`天气：${wx.provider}，匹配 ${wx.sampled} 段`)

  // 3) 逐段车速扫描（物理模型）
  const batch: any[] = []
  const meta: Array<{ seg: number; v: number }> = []
  segs.forEach((s, si) => {
    const level = String(s.roadLevel || 'other') as any
    const cap = Math.min((TRUCK_SPEED_MAX as any)[level] ?? 80, Math.max(s.avgSpeedKmh * 1.1, 40))
    SPEEDS.filter((v) => v <= cap).forEach((v) => {
      batch.push({
        distanceKm: s.distanceKm, avgSpeedKmh: v, gradePercent: s.gradePercent, elevationM: s.elevationM,
        temperatureC: s.temperatureC ?? 20, massKg: V.massKg, windSpeedKmh: s.windSpeedKmh ?? 0,
        windAffects: false, roadLevel: level, crr: V.crr, cd: V.cd, frontArea: V.frontArea,
        eta_mt: V.etaMt, p_fc_min: V.pFcMin, p_fc_max: V.pFcMax, p_bat_max: V.pBatMax,
        eta_fc: V.etaFc, p_aux0: V.pAux0, k_t: V.kT,
      })
      meta.push({ seg: si, v })
    })
  })
  log(`物理仿真 ${batch.length} 组（段×车速）...`)
  const phys = await runPhysics(batch)

  // 每段选经济车速
  const perSegOpts: Array<Array<{ v: number; h2Kg: number; eKWh: number; cost: number }>> = segs.map(() => [])
  meta.forEach((m, k) => {
    const r = phys[k]
    if (!r || r.h2_per_km_kg == null) return
    const s = segs[m.seg]
    const h2Kg = r.h2_per_km_kg * s.distanceKm
    const eKWh = r.E_fc ?? h2Kg * 33.3 * V.etaFc
    const cost = h2Kg * COST.h2Price + (COST.driverRate + LAMBDA) * (s.distanceKm / m.v)
    perSegOpts[m.seg].push({ v: m.v, h2Kg, eKWh, cost })
  })

  const planSegs = segs.map((s, i) => {
    const opts = perSegOpts[i]
    const best = opts.reduce((a, b) => (b.cost < a.cost ? b : a))
    return { ...s, planSpeed: best.v, planH2Kg: best.h2Kg, planEKWh: best.eKWh, planTimeH: s.distanceKm / best.v }
  })

  // 4) 累计能量曲线
  let cumE = 0, cumS = 0, cumT = 0
  const profile = planSegs.map((s) => {
    cumE += s.planEKWh; cumS += s.distanceKm; cumT += s.planTimeH
    return { s: cumS, e: cumE, t: cumT }
  })
  const totalKm = cumS, totalE = cumE, totalH2 = planSegs.reduce((a, s) => a + s.planH2Kg, 0)

  // 5) 站点走廊匹配
  const poly: Array<[number, number]> = candidate.polyline.split(';').filter(Boolean).map((p: string) => {
    const [lng, lat] = p.split(',').map(Number)
    return [lng, lat] as [number, number]
  })
  // 降采样折线（每 3 点取 1）加快匹配
  const polyDs = poly.filter((_, i) => i % 3 === 0 || i === poly.length - 1)
  const cumDs: number[] = [0]
  for (let i = 1; i < polyDs.length; i++) cumDs.push(cumDs[i - 1] + haversine(polyDs[i - 1], polyDs[i]))
  const routeLen = cumDs[cumDs.length - 1]

  const lngs = polyDs.map((p) => p[0]), lats = polyDs.map((p) => p[1])
  const bbox = { minLng: Math.min(...lngs) - 0.2, maxLng: Math.max(...lngs) + 0.2, minLat: Math.min(...lats) - 0.2, maxLat: Math.max(...lats) + 0.2 }

  function loadStations(file: string, kind: 'h2' | 'elec') {
    const gj = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', file), 'utf-8'))
    const out: any[] = []
    for (const f of gj.features || []) {
      const c = f.geometry?.coordinates
      if (!c) continue
      const lng = c[0], lat = c[1]
      if (lng < bbox.minLng || lng > bbox.maxLng || lat < bbox.minLat || lat > bbox.maxLat) continue
      const pr = projectToPolyline([lng, lat], polyDs, cumDs)
      const limit = kind === 'h2' ? 8 : 3 // 加氢站允许绕行更远
      if (pr.dist > limit) continue
      const props = f.properties || {}
      out.push({
        kind, name: props.name || '', lng, lat, s: pr.s * (totalKm / routeLen),
        detourKm: pr.dist * 2,
        price: kind === 'h2' ? (props.price ?? COST.h2Price) : COST.elecPrice,
      })
    }
    return out
  }
  const h2St = loadStations('stations.geojson', 'h2')
  const elSt = loadStations('charging_stations.geojson', 'elec')
  log(`走廊内：加氢站 ${h2St.length} 座，充电站 ${elSt.length} 座`)
  // 合并同位置站点（1km 内视为同一补能点）
  const stations: any[] = []
  for (const st of [...h2St, ...elSt].sort((a, b) => a.s - b.s)) {
    const near = stations.find((x) => Math.abs(x.s - st.s) < 1)
    if (near) near.types.add(st.kind)
    else stations.push({ s: st.s, types: new Set([st.kind]), detourKm: st.detourKm, name: st.name, h2Price: st.kind === 'h2' ? st.price : null, elecPrice: st.kind === 'elec' ? st.price : null })
  }
  stations.sort((a, b) => a.s - b.s)

  // 6) 双补能 DP
  const H_STEP = 0.25, SOC_STEP = 10
  const hLevels = Math.floor(V.h2CapacityKg / H_STEP) + 1
  const socLevels = Math.floor((V.socMax - V.socMin) / SOC_STEP) + 1
  const nodes = [{ s: 0, types: new Set(['none']), detourKm: 0, name: '起点', h2Price: null, elecPrice: null }, ...stations, { s: totalKm, types: new Set(['none']), detourKm: 0, name: '终点', h2Price: null, elecPrice: null }]
  const N = nodes.length
  // 节点处的累计能量/时间（按 s 插值）
  function energyAt(s: number) {
    let lo = profile.findIndex((p) => p.s >= s)
    if (lo <= 0) return { e: 0, t: 0 }
    const a = profile[lo - 1], b = profile[lo]
    const t = (s - a.s) / Math.max(b.s - a.s, 1e-9)
    return { e: a.e + t * (b.e - a.e), t: a.t + t * (b.t - a.t) }
  }
  const nodeE = nodes.map((n) => energyAt(n.s))
  const h2PerKWh = totalH2 / Math.max(totalE, 1e-6)   // 物理模型下每 kWh 电对应的氢耗

  const INF = Infinity
  // dp[i][h][soc] = { cost, prev, action }
  const dp: Array<Array<Float64Array>> = Array.from({ length: N }, () => Array.from({ length: hLevels }, () => new Float64Array(socLevels).fill(INF)))
  const prev: any = Array.from({ length: N }, () => Array.from({ length: hLevels }, () => new Array(socLevels).fill(null)))
  // 初始满氢 + 满电计入成本（真实成本结构），后续补能按站价计费
  // h=0 表示"已消耗 0kg"（满箱）；socLevels-1 表示 SOC_max（满电）
  dp[0][0][socLevels - 1] =
    V.h2CapacityKg * COST.h2Price + (V.socMax - V.socMin) / 100 * V.batCapacityKWh * COST.elecPrice

  const chargeTime = (kwh: number) => kwh / V.chargePowerKW + V.chargePlugH
  const travelTime = (i: number, j: number) => nodeE[j].t - nodeE[i].t
  const detourTime = (via: any) => (via.detourKm / 40) * 2 // 往返绕行

  for (let i = 0; i < N - 1; i++) {
    for (let h = 0; h < hLevels; h++) {
      for (let soc = 0; soc < socLevels; soc++) {
        const base = dp[i][h][soc]
        if (!isFinite(base)) continue
        const node = nodes[i]
        // 可选动作：加氢档位 / 充电档位
        const h2NowKg = V.h2CapacityKg - h * H_STEP
        // 加氢只给两个选项：不加 / 加满（加油站场景最自然）
        const hAdds = node.types.has('h2') ? [0, Math.max(0, V.h2CapacityKg - h2NowKg)] : [0]
        const eAdds = node.types.has('elec') ? [0, 20, 40, 60, 80, 100].filter((x) => x / (V.batCapacityKWh / socLevels) <= socLevels - 1 - soc) : [0]
        const FRACS = [0, 0.5, 1]   // 本次行程用电池承担的比例（其余由氢承担）
        for (const dh of hAdds) {
          for (const de of eAdds) {
            const h2 = V.h2CapacityKg - h * H_STEP      // 当前剩余氢
            const socNow = V.socMin + soc * SOC_STEP
            const h2After = Math.min(V.h2CapacityKg, h2 + dh)
            const socAfter = Math.min(V.socMax, socNow + (de / V.batCapacityKWh) * 100)
            const addTime = chargeTime(de) + (node.types.has('elec') && de > 0 ? detourTime(node) : 0)
            // 前往后续站点（最多跳过 2 个）
            for (let j = i + 1; j < Math.min(N, i + 4); j++) {
              const need = nodeE[j].e - nodeE[i].e
              if (need < 0) continue
              const availBat = Math.max(0, (socAfter - V.socMin) / 100 * V.batCapacityKWh)
              for (const frac of FRACS) {
                const batUse = Math.min(availBat, need * frac)
                const h2Use = (need - batUse) * h2PerKWh
                if (h2Use > h2After + 1e-6) continue
                const hLeft = h2After - h2Use
                const socLeft = socAfter - (batUse / V.batCapacityKWh) * 100
                // 保守取整：氢量向上（少算剩余）、SOC 向下（少算电量），避免离散化凭空造能量
                const hIdx = Math.max(0, Math.min(hLevels - 1, Math.round((V.h2CapacityKg - hLeft) / H_STEP)))
                const socIdx = Math.max(0, Math.min(socLevels - 1, Math.floor((socLeft - V.socMin) / SOC_STEP)))
                // 补能成本：加氢量×站价 + 充电量×电价 + 时间成本（含充电/绕行）
                const addCost = dh * (node.h2Price ?? COST.h2Price) + de * (node.elecPrice ?? COST.elecPrice)
                const cost = base + addCost + (COST.driverRate + LAMBDA) * (travelTime(i, j) + addTime)
                if (cost < dp[j][hIdx][socIdx]) {
                  dp[j][hIdx][socIdx] = cost
                  prev[j][hIdx][socIdx] = { i, h, soc, dh, de, j, frac }
                }
              }
            }
          }
        }
      }
    }
  }

  // 终点最小成本
  let bestCost = INF, bestState: any = null
  for (let h = 0; h < hLevels; h++) for (let soc = 0; soc < socLevels; soc++) {
    if (dp[N - 1][h][soc] < bestCost) { bestCost = dp[N - 1][h][soc]; bestState = { h, soc } }
  }
  // 回溯完整路径：补能计划 + 实际氢耗/电耗
  const stops: any[] = []
  const dpPath: any[] = []
  if (bestState) {
    let cur: any = { i: N - 1, ...bestState }
    while (cur) {
      dpPath.push(cur)
      const p = prev[cur.i][cur.h][cur.soc]
      if (!p) break
      if (p.dh > 0 || p.de > 0) {
        const node = nodes[p.i]
        stops.push({ s: node.s, name: node.name, h2Kg: p.dh, kWh: p.de, cost: p.dh * (node.h2Price ?? COST.h2Price) + p.de * (node.elecPrice ?? COST.elecPrice) })
      }
      cur = { i: p.i, h: p.h, soc: p.soc }
    }
    dpPath.reverse()
    stops.reverse()
  }
  // 沿 DP 路径统计实际能量使用（电池优先，剩余由氢补）
  let h2Used = 0, batUsed = 0, h2Refueled = 0, elecCharged = 0, chargeH = 0, travelH = 0
  for (let k = 1; k < dpPath.length; k++) {
    const a = dpPath[k - 1], b = dpPath[k]
    const p = prev[b.i][b.h][b.soc]
    if (!p) continue
    const socAfter = Math.min(V.socMax, V.socMin + p.soc * SOC_STEP + (p.de / V.batCapacityKWh) * 100)
    const need = nodeE[b.i].e - nodeE[a.i].e
    const availBat = Math.max(0, (socAfter - V.socMin) / 100 * V.batCapacityKWh)
    const batUse = Math.min(availBat, need * (p.frac ?? 0))
    h2Used += (need - batUse) * h2PerKWh
    batUsed += batUse
    h2Refueled += p.dh
    elecCharged += p.de
    if (p.de > 0) chargeH += chargeTime(p.de)
    travelH += nodeE[b.i].t - nodeE[a.i].t
  }

  // 7) 输出
  // ---- 动态重规划演示：行至 40% 处，前方 50km 突发拥堵（限速降 30%）----
  const s0 = totalKm * 0.4
  const eventEnd = s0 + 50
  let acc = 0
  const affectedIdx: number[] = []
  planSegs.forEach((s, i) => { acc += s.distanceKm; if (acc >= s0 && acc <= eventEnd) affectedIdx.push(i) })
  let replan: any = null
  if (affectedIdx.length > 0) {
    const reBatch: any[] = []
    const reMeta: Array<{ seg: number; v: number }> = []
    affectedIdx.forEach((si) => {
      const s = planSegs[si]
      const level = String(s.roadLevel || 'other') as any
      const cap = Math.min((TRUCK_SPEED_MAX as any)[level] ?? 80, Math.max(s.avgSpeedKmh * 1.1, 40)) * 0.7
      SPEEDS.filter((v) => v <= cap).forEach((v) => {
        reBatch.push({
          distanceKm: s.distanceKm, avgSpeedKmh: v, gradePercent: s.gradePercent, elevationM: s.elevationM,
          temperatureC: s.temperatureC ?? 20, massKg: V.massKg, windSpeedKmh: s.windSpeedKmh ?? 0,
          windAffects: false, roadLevel: level, crr: V.crr, cd: V.cd, frontArea: V.frontArea,
          eta_mt: V.etaMt, p_fc_min: V.pFcMin, p_fc_max: V.pFcMax, p_bat_max: V.pBatMax,
          eta_fc: V.etaFc, p_aux0: V.pAux0, k_t: V.kT,
        })
        reMeta.push({ seg: si, v })
      })
    })
    const rePhys = await runPhysics(reBatch)
    const reOpts: Array<Array<{ v: number; h2Kg: number; eKWh: number; cost: number }>> = affectedIdx.map(() => [])
    reMeta.forEach((m, k) => {
      const r = rePhys[k]
      if (!r || r.h2_per_km_kg == null) return
      const s = planSegs[m.seg]
      const h2Kg = r.h2_per_km_kg * s.distanceKm
      const eKWh = r.E_fc ?? h2Kg * 33.3 * V.etaFc
      reOpts[affectedIdx.indexOf(m.seg)].push({ v: m.v, h2Kg, eKWh, cost: h2Kg * COST.h2Price + (COST.driverRate + LAMBDA) * (s.distanceKm / m.v) })
    })
    const newPlanSegs = planSegs.map((s, i) => {
      const k = affectedIdx.indexOf(i)
      if (k < 0) return s
      const opts = reOpts[k]
      if (!opts.length) return s
      const best = opts.reduce((a, b) => (b.cost < a.cost ? b : a))
      return { ...s, planSpeed: best.v, planH2Kg: best.h2Kg, planEKWh: best.eKWh, planTimeH: s.distanceKm / best.v }
    })
    const newTime = newPlanSegs.reduce((a, s) => a + s.planTimeH, 0)
    const newH2 = newPlanSegs.reduce((a, s) => a + s.planH2Kg, 0)
    const newE = newPlanSegs.reduce((a, s) => a + s.planEKWh, 0)
    replan = {
      event: { atKm: round1(s0), lengthKm: 50, type: '拥堵', effect: '限速降 30%' },
      affectedSegments: affectedIdx.length,
      before: { timeH: round2(cumT), h2Kg: round2(totalH2), energyKWh: round1(totalE) },
      after: { timeH: round2(newTime), h2Kg: round2(newH2), energyKWh: round1(newE) },
      delta: { timeMin: round1((newTime - cumT) * 60), h2Kg: round2(newH2 - totalH2) },
      changed: affectedIdx.map((i) => ({
        index: planSegs[i].index, roadName: planSegs[i].roadName,
        oldSpeed: planSegs[i].planSpeed, newSpeed: newPlanSegs[i].planSpeed, km: planSegs[i].distanceKm,
      })),
    }
  }
  const out = {
    route: {
      distanceKm: candidate.distanceKm, durationH: candidate.durationH, tollsYuan: candidate.tollsYuan,
      polyline: candidate.polyline, topRoads: candidate.topRoads,
      from: origin, to: destination,
    },
    lambda: LAMBDA,
    vehicle: V, cost: COST,
    total: {
      km: totalKm, timeH: cumT, energyKWh: totalE, h2Kg: totalH2,
      h2Per100km: totalH2 / totalKm * 100,
      planCost: bestCost,
      h2UsedKg: h2Used, batUsedKWh: batUsed, h2RefueledKg: h2Refueled, elecChargedKWh: elecCharged,
      chargeH, travelH,
    },
    speedPlan: planSegs.map((s) => ({
      index: s.index, roadName: s.roadName, distanceKm: s.distanceKm, speed: s.planSpeed,
      gradePercent: s.gradePercent, elevationM: s.elevationM, temperatureC: s.temperatureC,
      windSpeedKmh: s.windSpeedKmh, trafficStatus: s.trafficStatus, h2Kg: s.planH2Kg,
    })),
    stations: stations.map((s) => ({ s: s.s, name: s.name, types: [...s.types], detourKm: s.detourKm })),
    stops,
    replan,
  }
  const outPath = path.isAbsolute(OUT_ARG) ? OUT_ARG : path.join(ROOT, OUT_ARG)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2))
  log(`完成：${totalKm.toFixed(1)}km，计划成本 ${bestCost.toFixed(0)} 元，补能 ${stops.length} 次`)
  if (replan) log(`动态重规划：40% 处拥堵 → 时间 +${replan.delta.timeMin} 分钟，氢耗 ${replan.delta.h2Kg >= 0 ? '+' : ''}${replan.delta.h2Kg}kg`)
  log('输出:', outPath)
}

main().catch((e) => { console.error('[plan] 失败:', e?.message || e); process.exit(1) })
