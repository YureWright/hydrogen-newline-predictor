/**
 * 报告导出面板（结果区「报告导出」tab，2026-08-23 新增）
 *
 * 功能：三路线全方位对比
 *   - 四条曲线：三条路线的速度曲线 / 机器学习氢耗曲线 / 物理模型氢耗曲线 / 电堆功率曲线
 *   - 一张总表：路线 ×（ML/物理氢耗 kg 与 kg/100km、燃料/过路费/司机/其他费用、柴油对比）
 *   - AI 推荐路线 + 原因（调用后端 /api/ai/recommend，DeepSeek）
 *   - PDF 导出：window.print() + @media print 只打印本面板
 *
 * 数据流：/api/route 取 3 条候选 → 逐条 /api/segments/start+轮询（DEM/OSM/天气，磁盘缓存）
 *       → /api/predict-hydrogen(model=both) → 费用估算 → /api/ai/recommend。
 */
import { useCallback, useState } from 'react'
import type { RouteCandidate, SegmentData } from '../route/types'
import { expectedStopCount } from '../route/segment'
import { LineAreaChartMemo } from './Charts'
import MarkdownLight from './MarkdownLight'

/* ================= 费用假设（界面明示，可在此调整） ================= */
export const COST_ASSUMPTIONS = {
  h2Price: 35,          // 氢价 元/kg
  dieselPrice: 7.5,     // 柴油价 元/L
  dieselL100: 30,       // 重卡百公里柴油油耗 L/100km
  driverRate: 60,       // 司机 元/h
  otherPerKm: 0.5,      // 其他（轮胎/保养/保险摊薄） 元/km
} as const

/** 物理模型所需车辆参数（SegmentsPanel 传入，结构兼容） */
export interface ReportVehicleParams {
  curbKg: number; crr: number; cd: number; frontArea: number; etaMt: number
  pFcMin: number; pFcMax: number; pBatMax: number; etaFc: number; pAux0: number; kT: number
}

interface RouteReport {
  index: number
  candidate: RouteCandidate
  segments: SegmentData[]
  ml: any               // /api/predict-hydrogen 返回的 ml
  physics: any          // 返回的 physics
  cost: {
    fuelYuan: number; tollYuan: number; driverYuan: number; otherYuan: number
    totalYuan: number; dieselYuan: number; deltaYuan: number
  }
}
interface ReportData {
  originName: string
  destinationName: string
  routes: RouteReport[]
  ai: { text: string; model: string } | null
}

interface Props {
  origin: string          // "lng,lat"
  destination: string
  originName: string
  destinationName: string
  departureTime: string
  vehicle: ReportVehicleParams
  fixedLoadT: number
}

/* ================= 工具 ================= */
function round1(n: number): number { return Math.round(n * 10) / 10 }
function round2(n: number): number { return Math.round(n * 100) / 100 }

/** 段行进航向角（与 SegmentsPanel 同款，供物理模型算逆风分量） */
function segHeadingDeg(coords?: Array<[number, number]>): number | null {
  if (!coords || coords.length < 2) return null
  const [lng1, lat1] = coords[0]
  const [lng2, lat2] = coords[coords.length - 1]
  const rad = Math.PI / 180
  const p1 = lat1 * rad, p2 = lat2 * rad, dl = (lng2 - lng1) * rad
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** 单次停车时长（s，按段主导行为类型；与 SegmentsPanel 一致） */
function stopSecondsFor(s: SegmentData): number {
  switch (s.motionBehavior) {
    case 'toll': return 60
    case 'serviceArea': return 40
    case 'intersection': return 30
    case 'ramp': return 20
    case 'turn': return 10
    default: return 30
  }
}

/** 与 SegmentsPanel runHydro 相同的精简 payload（含启停输入） */
function buildSlim(seg: SegmentData, v: ReportVehicleParams, loadT: number): any {
  return {
    index: seg.index, roadName: seg.roadName, distanceKm: seg.distanceKm, avgSpeedKmh: seg.avgSpeedKmh,
    gradePercent: seg.gradePercent, elevationM: seg.elevationM, temperatureC: seg.temperatureC,
    windSpeedKmh: seg.windSpeedKmh, humidityPct: seg.humidityPct, roadLevel: seg.roadLevel, durationH: seg.durationH,
    windDirDeg: seg.windDirDeg ?? null, windDirText: seg.windDirText ?? '',
    windAffects: seg.windAffects ?? false, headingDeg: segHeadingDeg(seg.coordsWgs84),
    massKg: Math.round(v.curbKg + loadT * 1000),
    gainM: seg.elevationGainM ?? 0,
    stopCount: Math.max(0, expectedStopCount(seg)),
    stopSecondsPer: stopSecondsFor(seg),
    crr: v.crr, cd: v.cd, frontArea: v.frontArea, eta_mt: v.etaMt,
    p_fc_min: v.pFcMin, p_fc_max: v.pFcMax, p_bat_max: v.pBatMax,
    eta_fc: v.etaFc, p_aux0: v.pAux0, k_t: v.kT,
  }
}

/** 费用估算（燃料按物理模型氢耗；柴油 = 里程 × 油耗/100 × 油价） */
function calcCost(c: RouteCandidate, physics: any): RouteReport['cost'] {
  const A = COST_ASSUMPTIONS
  const phTotal = physics?.total_h2_kg ?? 0
  const fuel = phTotal * A.h2Price
  const toll = c.tollsYuan || 0
  const driver = (c.durationH || 0) * A.driverRate
  const other = c.distanceKm * A.otherPerKm
  const total = fuel + toll + driver + other
  const diesel = c.distanceKm * (A.dieselL100 / 100) * A.dieselPrice
  return {
    fuelYuan: round1(fuel), tollYuan: round1(toll), driverYuan: round1(driver), otherYuan: round1(other),
    totalYuan: round1(total), dieselYuan: round1(diesel), deltaYuan: round1(total - diesel),
  }
}

/** 轮询等待路段测算任务完成 */
async function waitJob(jobId: string): Promise<{ segments: SegmentData[] }> {
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 1500))
    const r = await fetch('/api/segments/status?jobId=' + encodeURIComponent(jobId))
    const j = await r.json()
    if (j.ok && j.status === 'done') {
      const rr = await fetch('/api/segments/result?jobId=' + encodeURIComponent(jobId))
      const jj = await rr.json()
      if (jj.ok && Array.isArray(jj.segments)) return { segments: jj.segments as SegmentData[] }
      throw new Error(jj.msg || '获取路段结果失败')
    }
    if (j.ok && (j.status === 'error' || j.status === 'cancelled')) throw new Error(j.error || j.msg || '路段测算失败')
  }
  throw new Error('路段测算超时')
}

/* ================= 组件 ================= */
export default function ReportPanel({ origin, destination, originName, destinationName, departureTime, vehicle, fixedLoadT }: Props) {
  const [stage, setStage] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [err, setErr] = useState('')
  const [progress, setProgress] = useState<{ route: number; total: number; phase: string }>({ route: 0, total: 3, phase: '' })
  const [report, setReport] = useState<ReportData | null>(null)

  const generate = useCallback(async () => {
    setStage('running'); setErr('')
    try {
      // 1) 候选路线（最多 3 条）
      const rr = await fetch('/api/route?origin=' + encodeURIComponent(origin) + '&destination=' + encodeURIComponent(destination))
      const rj = await rr.json()
      if (!rj.ok || !rj.routes || rj.routes.length === 0) throw new Error(rj.msg || '路线查询失败')
      const cands = (rj.routes as RouteCandidate[]).slice(0, 3)
      const out: RouteReport[] = []

      // 2) 逐条：路段测算 → 双引擎预测 → 费用
      for (let i = 0; i < cands.length; i++) {
        setProgress({ route: i + 1, total: cands.length, phase: '路段测算（DEM/OSM/天气）' })
        const s = await fetch('/api/segments/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ origin, destination, index: i, departureTime }),
        })
        const sj = await s.json()
        if (!sj.ok || !sj.jobId) throw new Error(sj.msg || '路段测算启动失败')
        const { segments } = await waitJob(sj.jobId)

        setProgress({ route: i + 1, total: cands.length, phase: '氢耗预测（机器学习 + 物理模型）' })
        const slim = segments.map((seg) => buildSlim(seg, vehicle, fixedLoadT))
        const pr = await fetch('/api/predict-hydrogen', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segments: slim, departureTime, model: 'both' }),
        })
        const pj = await pr.json()
        if (!pj.ok) throw new Error(pj.msg || '氢耗预测失败')
        out.push({ index: i, candidate: cands[i], segments, ml: pj.ml, physics: pj.physics, cost: calcCost(cands[i], pj.physics) })
      }

      // 3) AI 推荐
      setProgress({ route: cands.length, total: cands.length, phase: 'AI 路线推荐' })
      let ai: ReportData['ai'] = null
      try {
        const ar = await fetch('/api/ai/recommend', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            origin: originName, destination: destinationName,
            routes: out.map((r) => ({
              index: r.index, distanceKm: r.candidate.distanceKm, durationH: r.candidate.durationH,
              tollsYuan: r.candidate.tollsYuan, avgSpeedKmh: r.candidate.avgSpeedKmh,
              highwayRatio: r.candidate.highwayRatio,
              ml: { totalH2Kg: r.ml?.total_h2_kg ?? 0, per100kmKg: r.ml?.per100km_kg ?? 0 },
              physics: { totalH2Kg: r.physics?.total_h2_kg ?? 0, per100kmKg: r.physics?.per100km_kg ?? 0 },
              cost: r.cost,
            })),
          }),
        })
        const aj = await ar.json()
        if (aj.ok && aj.text) ai = { text: aj.text, model: aj.model }
      } catch { /* AI 失败不阻断报告 */ }

      setReport({ originName, destinationName, routes: out, ai })
      setStage('done')
    } catch (e: any) {
      setErr((e && e.message) || String(e))
      setStage('error')
    }
  }, [origin, destination, originName, destinationName, departureTime, vehicle, fixedLoadT])

  /* ---- 图表数据 ---- */
  const speedSeries = (report?.routes ?? []).map((r, i) => {
    let cum = 0
    const pts = r.segments.map((s) => { cum += s.distanceKm; return { x: round1(cum), y: round1(s.avgSpeedKmh) } })
    return { label: '路线' + (i + 1), color: ROUTE_COLORS[i], points: pts }
  })
  const cumH2 = (segs: any[]) => {
    let cum = 0
    return segs.map((s) => { cum += s.distanceKm; return { x: round1(cum), y: round2(s.h2_kg ?? 0) } })
  }
  const mlH2Series = (report?.routes ?? []).map((r, i) => ({ label: '路线' + (i + 1), color: ROUTE_COLORS[i], points: cumH2(r.ml?.segments ?? []) }))
  const phH2Series = (report?.routes ?? []).map((r, i) => ({ label: '路线' + (i + 1), color: ROUTE_COLORS[i], points: cumH2(r.physics?.segments ?? []) }))
  const phPfcSeries = (report?.routes ?? []).map((r, i) => {
    let cum = 0
    const pts = (r.physics?.segments ?? []).map((s: any) => { cum += s.distanceKm; return { x: round1(cum), y: round1(s.P_fc ?? 0) } })
    return { label: '路线' + (i + 1), color: ROUTE_COLORS[i], points: pts }
  })

  const chart = (title: string, yLabel: string, unit: string, series: Array<{ label: string; color: string; points: Array<{ x: number; y: number }> }>) => (
    <div className="report-chart">
      <h4>{title}</h4>
      <LineAreaChartMemo points={series[0]?.points ?? []} color={series[0]?.color ?? ROUTE_COLORS[0]} yLabel={yLabel} unit={unit} series={series} />
    </div>
  )

  /* ---- 表格 ---- */
  const A = COST_ASSUMPTIONS
  const bestRoute = report?.routes.reduce((best, r) => (r.cost.totalYuan < best.cost.totalYuan ? r : best), report?.routes[0])

  return (
    <div className="report-export">
      <div className="report-head">
        <h3>📄 路线综合对比报告</h3>
        <p className="report-sub">{originName} → {destinationName} · 三条候选路线 · 机器学习 + 物理模型双引擎</p>
        {stage === 'done' && report && (
          <button className="btn-primary btn-report-pdf" onClick={() => window.print()}>⬇ 导出 PDF</button>
        )}
      </div>

      {stage === 'idle' && (
        <div className="report-empty">
          <p>生成三路线全方位对比报告：速度曲线 / 双引擎氢耗曲线 / 电堆曲线 / 费用构成（燃料、过路费、司机、其他）/ 柴油对比 / AI 推荐路线。</p>
          <p className="report-assume">费用假设（界面明示）：氢价 {A.h2Price} 元/kg（燃料按物理模型氢耗）· 柴油价 {A.dieselPrice} 元/L × {A.dieselL100} L/100km · 司机 {A.driverRate} 元/h · 其他 {A.otherPerKm} 元/km</p>
          <p className="report-note">首次生成需逐条测算三条路线（DEM/OSM/天气），同路线二次生成走缓存秒级。出发时间沿用当前测算设定。</p>
          <button className="btn-primary" onClick={generate}>
            ⚡ 生成报告
          </button>
        </div>
      )}

      {stage === 'running' && (
        <div className="report-running">
          <p>正在生成报告：路线 <b>{progress.route}/{progress.total}</b> · {progress.phase}…</p>
          <div className="report-progress"><div className="report-progress-fill" style={{ width: (progress.route / Math.max(progress.total, 1)) * 100 + '%' }} /></div>
        </div>
      )}

      {stage === 'error' && (
        <div className="error">{err}<div className="ai-actions"><button className="btn-cancel" onClick={() => setStage('idle')}>← 返回重试</button></div></div>
      )}

      {stage === 'done' && report && (
        <div className="report-body">
          {/* 四条曲线 */}
          <div className="report-charts">
            {chart('速度曲线（各段均速 km/h）', '均速', 'km/h', speedSeries)}
            {chart('机器学习氢耗曲线（累计 kg）', '氢耗', 'kg', mlH2Series)}
            {chart('物理模型氢耗曲线（累计 kg）', '氢耗', 'kg', phH2Series)}
            {chart('电堆功率曲线（物理模型，kW）', '电堆功率', 'kW', phPfcSeries)}
          </div>

          {/* 总表 */}
          <div className="report-table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th>路线</th>
                  <th>里程 km</th>
                  <th>时长 h</th>
                  <th>ML 氢耗 kg</th>
                  <th>ML kg/100km</th>
                  <th>物理 氢耗 kg</th>
                  <th>物理 kg/100km</th>
                  <th>燃料费 元</th>
                  <th>过路费 元</th>
                  <th>司机 元</th>
                  <th>其他 元</th>
                  <th>总费用 元</th>
                  <th>柴油费用 元</th>
                  <th>较柴油 ±元</th>
                </tr>
              </thead>
              <tbody>
                {report.routes.map((r, i) => (
                  <tr key={i} className={bestRoute && r === bestRoute ? 'row-best' : ''}>
                    <td>路线{i + 1}{bestRoute && r === bestRoute ? ' ⭐' : ''}</td>
                    <td>{r.candidate.distanceKm.toFixed(1)}</td>
                    <td>{r.candidate.durationH.toFixed(1)}</td>
                    <td>{(r.ml?.total_h2_kg ?? 0).toFixed(2)}</td>
                    <td>{(r.ml?.per100km_kg ?? 0).toFixed(2)}</td>
                    <td>{(r.physics?.total_h2_kg ?? 0).toFixed(2)}</td>
                    <td>{(r.physics?.per100km_kg ?? 0).toFixed(2)}</td>
                    <td>{r.cost.fuelYuan.toFixed(0)}</td>
                    <td>{r.cost.tollYuan.toFixed(0)}</td>
                    <td>{r.cost.driverYuan.toFixed(0)}</td>
                    <td>{r.cost.otherYuan.toFixed(0)}</td>
                    <td><b>{r.cost.totalYuan.toFixed(0)}</b></td>
                    <td>{r.cost.dieselYuan.toFixed(0)}</td>
                    <td className={r.cost.deltaYuan <= 0 ? 'pos' : 'neg'}>{r.cost.deltaYuan >= 0 ? '+' : ''}{r.cost.deltaYuan.toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="report-foot">⭐ = 总费用最低的路线（推荐基线，最终以 AI 综合评估为准）。燃料费按<b>物理模型</b>氢耗 × {A.h2Price} 元/kg；柴油 = 里程 × {A.dieselL100} L/100km × {A.dieselPrice} 元/L；司机 {A.driverRate} 元/h；其他 {A.otherPerKm} 元/km。ML 侧费用可按其氢耗 × {A.h2Price} 估算对比。</p>
            {report.routes.some((r) => (r.candidate.tollsYuan ?? 0) <= 0 && (r.candidate.tollDistanceKm ?? 0) > 0) && (
              <p className="report-warn">⚠️ 高德未返回部分路线的通行费（过路费按 0 计入），实际费用可能更高——请以收费站实收为准。</p>
            )}
          </div>

          {/* AI 推荐 */}
          <div className="report-ai">
            <h4>🤖 AI 路线推荐</h4>
            {report.ai ? (
              <div className="ai-box"><MarkdownLight text={report.ai.text} /><p className="report-ai-model">模型：{report.ai.model}</p></div>
            ) : (
              <p className="report-note">⚠️ AI 推荐生成失败（可能未配置 DEEPSEEK_API_KEY 或服务超时），请参考上表 ⭐ 最低费用路线。</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const ROUTE_COLORS = ['#3ae3ff', '#4d8dff', '#a473ff']
