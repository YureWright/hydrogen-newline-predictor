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
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RouteCandidate, SegmentData } from '../route/types'
import { expectedStopCount } from '../route/segment'
import { LineAreaChartMemo } from './Charts'
import MarkdownLight from './MarkdownLight'
import { jsPDF } from 'jspdf'
import html2canvas from 'html2canvas'
import MapView from './MapView'
import { fetchJson } from '../lib/fetchJson'

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
    totalYuan: number; dieselYuan: number; dieselTotalYuan: number; deltaYuan: number
  }
}
interface ReportData {
  originName: string
  destinationName: string
  routes: RouteReport[]
  ai: { text: string; model: string } | null
  /** AI 推荐失败的真实原因（后端 msg），供界面展示而非笼统提示 */
  aiError?: string
  generatedAt: string
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
function parseLngLat(s: string): [number, number] | null {
  if (!s) return null
  const [lng, lat] = s.split(',').map(Number)
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null
}

/** 起终点地图点（报告真地图用） */
function parseMapPoint(s: string, name: string): { name: string; lng: number; lat: number } | null {
  const ll = parseLngLat(s)
  return ll ? { name, lng: ll[0], lat: ll[1] } : null
}
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

/** 费用估算（燃料按物理模型氢耗；柴油燃料 = 里程 × 油耗/100 × 油价）。
 * 对比口径：氢能总费用 vs 柴油总费用（过路费/司机/其他两车相同，柴油总费用 = 柴油燃料 + 这三项），
 * 差价 = 氢总 − 柴总 = 氢燃料 − 柴油燃料（公共项抵消）。 */
function calcCost(c: RouteCandidate, physics: any): RouteReport['cost'] {
  const A = COST_ASSUMPTIONS
  const phTotal = physics?.total_h2_kg ?? 0
  const fuel = phTotal * A.h2Price
  const toll = c.tollsYuan || 0
  const driver = (c.durationH || 0) * A.driverRate
  const other = c.distanceKm * A.otherPerKm
  const total = fuel + toll + driver + other
  const diesel = c.distanceKm * (A.dieselL100 / 100) * A.dieselPrice
  const dieselTotal = diesel + toll + driver + other
  return {
    fuelYuan: round1(fuel), tollYuan: round1(toll), driverYuan: round1(driver), otherYuan: round1(other),
    totalYuan: round1(total), dieselYuan: round1(diesel), dieselTotalYuan: round1(dieselTotal),
    deltaYuan: round1(total - dieselTotal),
  }
}

/** 轮询等待路段测算任务完成 */
async function waitJob(jobId: string, onStatus?: (j: any) => void): Promise<{ segments: SegmentData[] }> {
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 1500))
    const j = await fetchJson<any>('/api/segments/status?jobId=' + encodeURIComponent(jobId), undefined, 2, 600)
    if (onStatus) onStatus(j)
    if (j.ok && j.status === 'done') {
      const jj = await fetchJson<any>('/api/segments/result?jobId=' + encodeURIComponent(jobId), undefined, 3, 800)
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
  // 详细进度日志流（评委看到实时在跑，不会误判卡死）
  const [logs, setLogs] = useState<Array<{ id: number; msg: string; level: 'info' | 'ok' | 'warn' }>>([])
  const logSeq = useRef(0)
  const logsRef = useRef<HTMLDivElement>(null)
  const pushLog = useCallback((msg: string, level: 'info' | 'ok' | 'warn' = 'info') => {
    logSeq.current += 1
    setLogs((prev) => [...prev.slice(-80), { id: logSeq.current, msg, level }])
  }, [])
  // 已用秒数
  const [runElapsed, setRunElapsed] = useState(0)
  useEffect(() => {
    if (stage !== 'running') { setRunElapsed(0); return }
    const t = window.setInterval(() => setRunElapsed((s) => s + 1), 1000)
    return () => window.clearInterval(t)
  }, [stage])
  // 日志自动滚到底部
  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight
  }, [logs])
  // PDF 导出（jsPDF + html2canvas 截图渲染，不用浏览器打印）
  const pdfRef = useRef<HTMLDivElement>(null)
  const [pdfBusy, setPdfBusy] = useState(false)
  const exportPdf = useCallback(async () => {
    const el = pdfRef.current
    if (!el || pdfBusy) return
    setPdfBusy(true)
    el.classList.add('capturing')            // 隐藏导出按钮本身，避免进 PDF
    try {
      await new Promise((r) => setTimeout(r, 1200))
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
      const pageW = 297, pageH = 210, margin = 12
      const usableW = pageW - margin * 2
      const usableH = pageH - margin * 2
      let y = margin
      let pageCount = 1
      const secSel = '.report-cover, .report-params, .report-summary-cards, .report-map, .report-chart, .report-cost-bars, .report-table-wrap, .report-top-segs, .report-ai, .report-footer-block'
      const sections = Array.from(el.querySelectorAll<HTMLElement>(secSel))
      for (const sec of sections) {
        const canvas = await html2canvas(sec, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false })
        let imgW = usableW
        let imgH = (canvas.height * imgW) / canvas.width
        if (imgH > usableH) {
          imgH = usableH
          imgW = (canvas.width * imgH) / canvas.height
        }
        if (y + imgH > pageH - margin + 0.5) {
          pdf.addPage()
          pageCount += 1
          y = margin
        }
        pdf.addImage(canvas.toDataURL('image/png'), 'PNG', margin, y, imgW, imgH, undefined, 'FAST')
        y += imgH + 4
      }
      const totalPages = pdf.getNumberOfPages()
      for (let p = 1; p <= totalPages; p++) {
        pdf.setPage(p)
        pdf.setFontSize(8)
        pdf.setTextColor(160)
        // jsPDF 默认字体(helvetica)不支持中文，页脚用 ASCII 避免乱码
        pdf.text('Page ' + p + ' / ' + totalPages, pageW - margin, pageH - 4, { align: 'right' })
        pdf.text('Hydrogen Truck Route H2 Prediction System', margin, pageH - 4)
      }
      pdf.save(`氢耗预测报告_${originName}_${destinationName}.pdf`)
      pushLog('✅ PDF 已导出（' + totalPages + ' 页，A4 横向，白底专业排版）', 'ok')
    } catch (e: any) {
      pushLog('❌ PDF 导出失败：' + ((e && e.message) || String(e)), 'warn')
    } finally {
      el.classList.remove('capturing')
      setPdfBusy(false)
    }
  }, [originName, destinationName, pdfBusy, pushLog])

  const generate = useCallback(async () => {
    setStage('running'); setErr('')
    try {
      // 1) 候选路线（最多 3 条）
      const rj = await fetchJson<any>('/api/route?origin=' + encodeURIComponent(origin) + '&destination=' + encodeURIComponent(destination))
      if (!rj.ok || !rj.routes || rj.routes.length === 0) throw new Error(rj.msg || '路线查询失败')
      const cands = (rj.routes as RouteCandidate[]).slice(0, 3)
      const out: RouteReport[] = []

      // 2) 逐条：路段测算 → 双引擎预测 → 费用
      for (let i = 0; i < cands.length; i++) {
        setProgress({ route: i + 1, total: cands.length, phase: '路段测算（DEM/OSM/天气）' })
        pushLog(`📦 路线 ${i + 1}/${cands.length}：开始路段测算（DEM 高程 / OSM 真实路网 / 沿线天气）`)
        const sj = await fetchJson<any>('/api/segments/start', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ origin, destination, index: i, departureTime }),
        })
        if (!sj.ok || !sj.jobId) throw new Error(sj.msg || '路段测算启动失败')
        let lastJobKey = ''
        const { segments } = await waitJob(sj.jobId, (j) => {
          if (!j || !j.ok) return
          const key = (j.phase || '') + '|' + (j.done ?? 0) + '|' + (j.total ?? 0)
          if (key === lastJobKey) return
          lastJobKey = key
          const ph = j.phase
          if (ph === 'route') pushLog('  · 路线分段')
          else if (ph === 'dem') pushLog(`  · DEM 高程瓦片 ${j.done}/${j.total}${j.cached ? `（已缓存 ${j.cached}）` : ''}`)
          else if (ph === 'osm-query') pushLog(`  · OSM 真实路网 分块 ${Math.min((j.done ?? 0) + 1, j.total || 1)}/${j.total}（公共镜像较慢属正常）`)
          else if (ph === 'osm-match') pushLog('  · OSM 道路匹配')
          else if (ph === 'weather') pushLog('  · 抓取沿线天气（按出发时间匹配温度/风/湿度/降水）')
          else if (ph === 'compute') pushLog('  · 计算坡度与海拔')
        })
        pushLog(`  ✅ 路线 ${i + 1} 路段数据就绪（${segments.length} 段）`, 'ok')

        setProgress({ route: i + 1, total: cands.length, phase: '氢耗预测（机器学习 + 物理模型）' })
        pushLog(`⚡ 路线 ${i + 1}：双引擎氢耗预测（机器学习 + 物理模型）`)
        const slim = segments.map((seg) => buildSlim(seg, vehicle, fixedLoadT))
        const pj = await fetchJson<any>('/api/predict-hydrogen', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ segments: slim, departureTime, model: 'both' }),
        })
        if (!pj.ok) throw new Error(pj.msg || '氢耗预测失败')
        out.push({ index: i, candidate: cands[i], segments, ml: pj.ml, physics: pj.physics, cost: calcCost(cands[i], pj.physics) })
        pushLog(`  ✅ 路线 ${i + 1} 氢耗预测完成（ML ${(pj.ml?.total_h2_kg ?? 0).toFixed(2)}kg / 物理 ${(pj.physics?.total_h2_kg ?? 0).toFixed(2)}kg）`, 'ok')
      }

      // 3) AI 推荐
      setProgress({ route: cands.length, total: cands.length, phase: 'AI 路线推荐' })
      pushLog('🤖 AI 路线推荐（DeepSeek 比较三条路线 + 费用构成）')
      let ai: ReportData['ai'] = null
      let aiError = ''
      try {
        const aj = await fetchJson<any>('/api/ai/recommend', {
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
        if (aj.ok && aj.text) ai = { text: aj.text, model: aj.model }
        else aiError = aj?.msg || 'AI 服务返回失败'
      } catch (e: any) { /* AI 失败不阻断报告 */ aiError = (e?.message || 'AI 请求异常（网络/超时）') }

      setReport({ originName, destinationName, routes: out, ai, aiError, generatedAt: new Date().toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) })
      setStage('done')
      pushLog('✅ 报告生成完成，可查看图表 / 总表 / AI 推荐，并导出 PDF', 'ok')
    } catch (e: any) {
      pushLog('❌ 生成失败：' + ((e && e.message) || String(e)), 'warn')
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
      <LineAreaChartMemo points={series[0]?.points ?? []} color={series[0]?.color ?? ROUTE_COLORS[0]} yLabel={yLabel} unit={unit} series={series} height={300} />
    </div>
  )

  /* ---- 表格 ---- */
  const A = COST_ASSUMPTIONS
  const bestRoute = report?.routes.reduce((best, r) => (r.cost.totalYuan < best.cost.totalYuan ? r : best), report?.routes[0])

  return (
    <div className="report-export" ref={pdfRef}>
      <div className="report-head">
        <h3>📄 路线综合对比报告</h3>
        <p className="report-sub">{originName} → {destinationName} · 三条候选路线 · 机器学习 + 物理模型双引擎</p>
        {stage === 'done' && report && (
          <button className="btn-primary btn-report-pdf" onClick={exportPdf} disabled={pdfBusy}>{pdfBusy ? '⏳ 导出中…' : '⬇ 导出 PDF'}</button>
        )}
      </div>

      {stage === 'idle' && (
        <div className="report-empty">
          <p>生成三路线全方位对比报告：速度曲线 / 双引擎氢耗曲线 / 电堆曲线 / 费用构成（燃料、过路费、司机、其他）/ 柴油对比 / AI 推荐路线。</p>
          <p className="report-assume">费用假设（界面明示）：氢价 {A.h2Price} 元/kg（燃料按物理模型氢耗）· 柴油价 {A.dieselPrice} 元/L × {A.dieselL100} L/100km · 司机 {A.driverRate} 元/h · 其他 {A.otherPerKm} 元/km</p>
          <p className="report-note">⏳ 首次生成约 5~10 分钟属正常：三条路线<b>串行</b>测算（避免同时请求打爆公共镜像），最慢的是 OSM 真实路网（Overpass 公共镜像，每分块 10~70s）与沿线天气抓取；同路线二次生成走磁盘缓存明显加快。生成过程中有<b>实时日志</b>显示每一步进度，不会卡死。</p>
          <button className="btn-primary" onClick={generate}>
            ⚡ 生成报告
          </button>
        </div>
      )}

      {stage === 'running' && (
        <div className="report-running">
          <p>正在生成报告：路线 <b>{progress.route}/{progress.total}</b> · {progress.phase}…（已用 {runElapsed}s）</p>
          <div className="report-progress"><div className="report-progress-fill" style={{ width: (progress.route / Math.max(progress.total, 1)) * 100 + '%' }} /></div>
          <p className="report-note">⏳ 首次生成约 5~10 分钟属正常：三条路线<b>串行</b>测算（避免同时请求打爆公共镜像），最慢的是 OSM 真实路网（Overpass 公共镜像，每分块 10~70s）与沿线天气抓取；同路线二次生成走磁盘缓存明显加快。下方日志实时显示每一步进度：</p>
          <div className="report-logs" ref={logsRef}>
            {logs.length === 0 ? <div className="log-info">准备中…</div> : logs.map((l) => (
              <div key={l.id} className={'log-' + l.level}>{l.msg}</div>
            ))}
          </div>
        </div>
      )}

      {stage === 'error' && (
        <div className="error">{err}<div className="ai-actions"><button className="btn-cancel" onClick={() => setStage('idle')}>← 返回重试</button></div></div>
      )}

      {stage === 'done' && report && (
        <div className="report-body">
          {/* ===== 1. 封面信息区 ===== */}
          <div className="report-cover">
            <div className="cover-title">氢能重卡路线综合分析报告</div>
            <div className="cover-route">{originName} → {destinationName}</div>
            <div className="cover-meta">
              <span>生成时间：{report.generatedAt}</span>
              <span>分析引擎：机器学习 + 物理模型双引擎</span>
              <span>候选路线：{report.routes.length} 条</span>
            </div>
          </div>

          {/* ===== 2. 车辆参数 & 费用假设 ===== */}
          <div className="report-params">
            <div className="params-col">
              <h4>车辆参数</h4>
              <table className="params-table">
                <tbody>
                  <tr><td>整备质量</td><td>{vehicle.curbKg.toLocaleString()} kg</td></tr>
                  <tr><td>载货质量</td><td>{(fixedLoadT * 1000).toLocaleString()} kg（{fixedLoadT}t）</td></tr>
                  <tr><td>总质量</td><td>{(vehicle.curbKg + fixedLoadT * 1000).toLocaleString()} kg</td></tr>
                  <tr><td>滚动阻力系数</td><td>{vehicle.crr}</td></tr>
                  <tr><td>风阻系数 × 迎风面积</td><td>{vehicle.cd} × {vehicle.frontArea} m²</td></tr>
                  <tr><td>电堆功率范围</td><td>{vehicle.pFcMin} ~ {vehicle.pFcMax} kW</td></tr>
                  <tr><td>电堆效率</td><td>{(vehicle.etaFc * 100).toFixed(0)}%</td></tr>
                  <tr><td>传动效率</td><td>{(vehicle.etaMt * 100).toFixed(0)}%</td></tr>
                </tbody>
              </table>
            </div>
            <div className="params-col">
              <h4>费用假设</h4>
              <table className="params-table">
                <tbody>
                  <tr><td>氢价</td><td>{A.h2Price} 元/kg</td></tr>
                  <tr><td>柴油价</td><td>{A.dieselPrice} 元/L</td></tr>
                  <tr><td>柴油百公里油耗</td><td>{A.dieselL100} L/100km</td></tr>
                  <tr><td>司机费用</td><td>{A.driverRate} 元/h</td></tr>
                  <tr><td>其他成本</td><td>{A.otherPerKm} 元/km</td></tr>
                  <tr><td>燃料费计算</td><td>物理模型氢耗 × 氢价</td></tr>
                  <tr><td>对比口径</td><td>氢能总费用 vs 柴油总费用</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* ===== 3. 路线概览摘要卡片 ===== */}
          <div className="report-section-title">路线概览</div>
          <div className="report-summary-cards">
            {report.routes.map((r, i) => {
              const isBest = bestRoute && r === bestRoute
              return (
                <div key={i} className={'summary-card' + (isBest ? ' card-best' : '')}>
                  <div className="card-header" style={{ borderColor: ROUTE_COLORS[i] }}>
                    <span className="card-route" style={{ color: ROUTE_COLORS[i] }}>路线 {i + 1}</span>
                    {isBest && <span className="card-badge">推荐</span>}
                  </div>
                  <div className="card-metrics">
                    <div className="metric"><span className="metric-val">{r.candidate.distanceKm.toFixed(1)}</span><span className="metric-lbl">里程 km</span></div>
                    <div className="metric"><span className="metric-val">{r.candidate.durationH.toFixed(1)}</span><span className="metric-lbl">时长 h</span></div>
                    <div className="metric"><span className="metric-val">{((r.candidate.highwayRatio ?? 0) * 100).toFixed(0)}%</span><span className="metric-lbl">高速占比</span></div>
                    <div className="metric"><span className="metric-val">{(r.physics?.total_h2_kg ?? 0).toFixed(2)}</span><span className="metric-lbl">物理氢耗 kg</span></div>
                    <div className="metric"><span className="metric-val">{(r.ml?.total_h2_kg ?? 0).toFixed(2)}</span><span className="metric-lbl">ML氢耗 kg</span></div>
                    <div className="metric"><span className="metric-val">{r.cost.totalYuan.toFixed(0)}</span><span className="metric-lbl">总费用 元</span></div>
                  </div>
                  <div className="card-delta" style={{ color: r.cost.deltaYuan <= 0 ? '#16a34a' : '#dc2626' }}>
                    较柴油 {r.cost.deltaYuan >= 0 ? '+' : ''}{r.cost.deltaYuan.toFixed(0)} 元
                  </div>
                </div>
              )
            })}
          </div>

          {/* ===== 4. 三路线地图 ===== */}
          <div className="report-section-title">路线地图</div>
          <div className="report-map">
            <div className="report-map-canvas">
              <MapView
                routes={report.routes.map((r) => r.candidate)}
                selectedIndex={-1}
                onSelect={() => {}}
                from={parseMapPoint(origin, originName)}
                to={parseMapPoint(destination, destinationName)}
                stations={[]}
              />
            </div>
          </div>

          {/* ===== 5. 四条曲线 ===== */}
          <div className="report-section-title">数据曲线</div>
          <div className="report-charts">
            {chart('速度曲线（各段均速 km/h）', '均速', 'km/h', speedSeries)}
            {chart('机器学习氢耗曲线（累计 kg）', '氢耗', 'kg', mlH2Series)}
            {chart('物理模型氢耗曲线（累计 kg）', '氢耗', 'kg', phH2Series)}
            {chart('电堆功率曲线（物理模型，kW）', '电堆功率', 'kW', phPfcSeries)}
          </div>

          {/* ===== 6. 费用对比可视化 ===== */}
          <div className="report-section-title">费用对比</div>
          <div className="report-cost-bars">
            {report.routes.map((r, i) => {
              const maxCost = Math.max(...report.routes.map((x) => Math.max(x.cost.totalYuan, x.cost.dieselTotalYuan)), 1)
              return (
                <div key={i} className="cost-row">
                  <div className="cost-label" style={{ color: ROUTE_COLORS[i] }}>路线 {i + 1}</div>
                  <div className="cost-pair">
                    <div className="cost-bar-wrap">
                      <span className="cost-type">氢能</span>
                      <div className="cost-bar">
                        <div className="cost-fill cost-h2" style={{ width: `${(r.cost.totalYuan / maxCost) * 100}%` }}>
                          <span className="cost-detail">燃料 {r.cost.fuelYuan.toFixed(0)} + 过路 {r.cost.tollYuan.toFixed(0)} + 司机 {r.cost.driverYuan.toFixed(0)} + 其他 {r.cost.otherYuan.toFixed(0)}</span>
                        </div>
                        <span className="cost-total">{r.cost.totalYuan.toFixed(0)} 元</span>
                      </div>
                    </div>
                    <div className="cost-bar-wrap">
                      <span className="cost-type">柴油</span>
                      <div className="cost-bar">
                        <div className="cost-fill cost-diesel" style={{ width: `${(r.cost.dieselTotalYuan / maxCost) * 100}%` }}>
                          <span className="cost-detail">燃料 {r.cost.dieselYuan.toFixed(0)} + 过路 {r.cost.tollYuan.toFixed(0)} + 司机 {r.cost.driverYuan.toFixed(0)} + 其他 {r.cost.otherYuan.toFixed(0)}</span>
                        </div>
                        <span className="cost-total">{r.cost.dieselTotalYuan.toFixed(0)} 元</span>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* ===== 7. 详细数据总表 ===== */}
          <div className="report-section-title">详细数据总表</div>
          <div className="report-table-wrap">
            <table className="report-table">
              <thead>
                <tr>
                  <th>路线</th>
                  <th>里程 km</th>
                  <th>时长 h</th>
                  <th>ML 氢耗 kg</th>
                  <th>ML kg/100km</th>
                  <th>物理氢耗 kg</th>
                  <th>物理 kg/100km</th>
                  <th>燃料费 元</th>
                  <th>过路费 元</th>
                  <th>司机 元</th>
                  <th>其他 元</th>
                  <th>总费用 元</th>
                  <th>柴油总费用 元</th>
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
                    <td>{r.cost.dieselTotalYuan.toFixed(0)}</td>
                    <td className={r.cost.deltaYuan <= 0 ? 'pos' : 'neg'}>{r.cost.deltaYuan >= 0 ? '+' : ''}{r.cost.deltaYuan.toFixed(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="report-foot">⭐ = 总费用最低路线。燃料费 = 物理模型氢耗 × {A.h2Price} 元/kg；柴油 = 里程 × {A.dieselL100} L/100km × {A.dieselPrice} 元/L；「较柴油±」= 氢燃料费 − 柴油燃料费。</p>
            {report.routes.some((r) => (r.candidate.tollsYuan ?? 0) <= 0 && (r.candidate.tollDistanceKm ?? 0) > 0) && (
              <p className="report-warn">⚠️ 高德未返回部分路线的通行费（过路费按 0 计入），实际费用可能更高。</p>
            )}
          </div>

          {/* ===== 8. 路段氢耗 Top5 ===== */}
          <div className="report-section-title">各路线氢耗最高路段（Top 5）</div>
          <div className="report-top-segs">
            {report.routes.map((r, i) => {
              const segs = (r.physics?.segments ?? []) as Array<{ roadName?: string; distanceKm: number; h2_kg: number; avgSpeedKmh?: number; gradePercent?: number; P_fc?: number }>
              const top5 = [...segs].sort((a, b) => (b.h2_kg ?? 0) - (a.h2_kg ?? 0)).slice(0, 5)
              return (
                <div key={i} className="top-seg-col">
                  <h5 style={{ color: ROUTE_COLORS[i] }}>路线 {i + 1}</h5>
                  <table className="top-seg-table">
                    <thead><tr><th>路段</th><th>距离 km</th><th>氢耗 kg</th><th>均速 km/h</th><th>坡度 %</th><th>电堆 kW</th></tr></thead>
                    <tbody>
                      {top5.map((s, j) => (
                        <tr key={j}>
                          <td>{s.roadName || `段${j + 1}`}</td>
                          <td>{(s.distanceKm ?? 0).toFixed(2)}</td>
                          <td><b>{(s.h2_kg ?? 0).toFixed(3)}</b></td>
                          <td>{(s.avgSpeedKmh ?? 0).toFixed(0)}</td>
                          <td>{(s.gradePercent ?? 0).toFixed(1)}</td>
                          <td>{(s.P_fc ?? 0).toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            })}
          </div>

          {/* ===== 9. AI 推荐 ===== */}
          <div className="report-section-title">AI 路线推荐</div>
          <div className="report-ai">
            {report.ai ? (
              <div className="ai-box"><MarkdownLight text={report.ai.text} /><p className="report-ai-model">模型：{report.ai.model}</p></div>
            ) : (
              <p className="report-note">⚠️ AI 推荐生成失败：{report.aiError || '可能未配置 DEEPSEEK_API_KEY 或服务超时'}。请参考上表 ⭐ 最低费用路线。</p>
            )}
          </div>

          {/* ===== 10. 报告尾页 ===== */}
          <div className="report-footer-block">
            <div className="footer-line" />
            <p>本报告由「氢能重卡路线氢耗预测系统」自动生成，仅供运营规划参考。实际氢耗受驾驶行为、天气变化、车辆状态等因素影响，可能与预测值存在偏差。</p>
            <p className="footer-meta">生成时间：{report.generatedAt} ｜ 分析引擎：ML + 物理双引擎 ｜ 队伍：氢氢敲醒沉睡的新能源车</p>
          </div>
        </div>
      )}
    </div>
  )
}

const ROUTE_COLORS = ['#3ae3ff', '#4d8dff', '#a473ff']
