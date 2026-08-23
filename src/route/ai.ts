/**
 * AI 路线评估模块（Node 侧，供 vite 中间件调用）
 *
 * 配置（环境变量 / .env，均为服务端，不进入浏览器）：
 *   DEEPSEEK_API_KEY  必填
 *   DEEPSEEK_BASE_URL 可选，默认 https://api.deepseek.com（OpenAI 兼容端点）
 *   DEEPSEEK_MODEL    可选，默认 deepseek-v4-flash
 */
import type { RoadLevel, RouteCandidate, SegmentData, SegmentSummary } from './types'
import { ROAD_LEVEL_LABEL } from './segment'

export interface AiConfig {
  apiKey: string
  baseUrl?: string
  model?: string
}

export function getAiConfig(): AiConfig {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('缺少环境变量 DEEPSEEK_API_KEY（AI 评估功能需要）')
  return {
    apiKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  }
}

export interface RouteEvalInput {
  origin: string
  destination: string
  candidate: RouteCandidate
  segments: SegmentData[]
  summary: SegmentSummary
}

const SYSTEM_PROMPT =
  '你是氢能重卡运营与能耗分析专家，服务于新能源重卡销售决策。' +
  '基于给定的新线路分段数据（含坡度/海拔/路况），输出简洁、可执行的专业评估。' +
  '只输出评估正文，使用 markdown 结构（### 小标题 + 要点列表），总字数控制在 400 字以内。'

function buildPrompt(input: RouteEvalInput): string {
  const { candidate, segments, summary } = input
  const c = candidate
  const s = summary
  const lines: string[] = []
  lines.push('【线路概况】')
  lines.push(`起点 ${input.origin} → 终点 ${input.destination}`)
  lines.push(`里程 ${c.distanceKm}km，预计 ${c.durationH}h，均速 ${c.avgSpeedKmh}km/h，高速占比 ${(c.highwayRatio * 100).toFixed(0)}%，过路费 ${c.tollsYuan} 元`)
  lines.push(`实时路况：畅通 ${c.traffic.smoothKm}km / 缓行 ${c.traffic.slowKm} / 拥堵 ${c.traffic.congestedKm} / 严重 ${c.traffic.severeKm}，拥堵占比 ${(c.traffic.congestionRatio * 100).toFixed(1)}%`)
  lines.push('')
  lines.push('【路段汇总】')
  // 由 ROAD_LEVEL_LABEL 生成，保证新增道路等级时不会漏列（漏列会让各等级里程之和对不上总里程，
  // 模型拿到一份自相矛盾的数据）
  const levelParts = (Object.keys(ROAD_LEVEL_LABEL) as RoadLevel[])
    .filter((k) => (s.roadLevelKm[k] ?? 0) > 0)
    .map((k) => `${ROAD_LEVEL_LABEL[k]} ${s.roadLevelKm[k]}km`)
  lines.push(`共 ${s.segmentCount} 段，合计 ${s.totalKm}km；` + (levelParts.join('，') || '无等级数据'))
  if (s.avgGradePercent != null) lines.push(`里程加权平均坡度 ${s.avgGradePercent}%，平均海拔 ${s.avgElevationM ?? '-'}m`)
  const gains = segments.reduce((a, x) => a + (x.elevationGainM ?? 0), 0)
  const losses = segments.reduce((a, x) => a + (x.elevationLossM ?? 0), 0)
  if (gains > 0 || losses > 0) lines.push(`累计爬升 ${Math.round(gains)}m，累计下降 ${Math.round(losses)}m`)
  lines.push('')
  lines.push('【关键路段 Top6（按里程）】')
  const top = [...segments].sort((a, b) => b.distanceKm - a.distanceKm).slice(0, 6)
  for (const seg of top) {
    lines.push(
      `- ${seg.roadName || '未命名'}（${seg.roadLevel}${seg.roadSource === 'osm' ? '·OSM' : '·规则'}）${seg.distanceKm}km，均速 ${seg.avgSpeedKmh}km/h，坡度 ${seg.gradePercent ?? '-'}%，海拔 ${seg.elevationM ?? '-'}m，地形 ${seg.terrain ?? '-'}，温度 ${seg.temperatureC ?? '-'}℃，风速 ${seg.windSpeedKmh ?? '-'}km/h，路况 ${seg.trafficStatus}`,
    )
  }
  lines.push('')
  lines.push('请从以下角度评估：')
  lines.push('1. 总体判断：该线路氢能重卡运营的可行性；')
  lines.push('2. 关键影响因素：坡度/路况/高速占比/海拔对氢耗的影响排序；')
  lines.push('3. 风险路段：长上坡、拥堵、高海拔等需注意的路段；')
  lines.push('4. 运营建议：载重、巡航速度、补能站点选择等可执行建议。')
  return lines.join('\n')
}

export async function evaluateRoute(
  input: RouteEvalInput,
  config: AiConfig,
): Promise<{ text: string; model: string }> {
  const baseUrl = (config.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '')
  const model = config.model || 'deepseek-v4-flash'
  const r = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + config.apiKey,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildPrompt(input) },
      ],
      temperature: 0.3,
      max_tokens: 1200,
    }),
    signal: AbortSignal.timeout(60000),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error('AI 请求失败 HTTP ' + r.status + ': ' + t.slice(0, 300))
  }
  const j: any = await r.json()
  const text = j.choices?.[0]?.message?.content ?? ''
  if (!text) throw new Error('AI 返回内容为空：' + JSON.stringify(j).slice(0, 200))
  return { text, model }
}

/* ================= 报告：三路线对比 + AI 推荐（2026-08-23 新增） ================= */

export interface RouteReportSummary {
  index: number
  distanceKm: number
  durationH: number
  tollsYuan: number
  avgSpeedKmh: number
  highwayRatio: number
  ml: { totalH2Kg: number; per100kmKg: number }
  physics: { totalH2Kg: number; per100kmKg: number }
  cost: {
    fuelYuan: number; tollYuan: number; driverYuan: number; otherYuan: number
    totalYuan: number; dieselYuan: number; deltaYuan: number
  }
}

export interface RouteRecommendInput {
  origin: string
  destination: string
  routes: RouteReportSummary[]
}

const RECOMMEND_SYSTEM_PROMPT =
  '你是氢能重卡运营与成本分析专家，服务于新能源重卡销售决策。' +
  '给定三条候选路线的里程/时长/过路费/氢耗（机器学习与物理模型双口径）与费用构成（燃料/过路费/司机/其他）及柴油对比，' +
  '推荐最值得运营的一条路线并说明理由。输出 markdown：先一行结论「推荐路线 X」，再分点列出理由（成本、氢耗、时效、路况风险），' +
  '最后给出可执行的运营建议（如建议载重/巡航速度/补能点）。总字数控制在 400 字以内，实事求是，不编造数据。'

function buildRecommendPrompt(input: RouteRecommendInput): string {
  const lines: string[] = []
  lines.push(`起点 ${input.origin} → 终点 ${input.destination}，共 ${input.routes.length} 条候选路线：`)
  lines.push('')
  for (const r of input.routes) {
    lines.push(`【路线 ${r.index + 1}】`)
    lines.push(`里程 ${r.distanceKm}km，预计 ${r.durationH}h，均速 ${r.avgSpeedKmh}km/h，高速占比 ${(r.highwayRatio * 100).toFixed(0)}%，过路费 ${r.tollsYuan} 元`)
    lines.push(`机器学习氢耗 ${r.ml.totalH2Kg.toFixed(2)}kg（${r.ml.per100kmKg.toFixed(2)}kg/100km）；物理模型氢耗 ${r.physics.totalH2Kg.toFixed(2)}kg（${r.physics.per100kmKg.toFixed(2)}kg/100km）`)
    lines.push(`费用构成：燃料 ${r.cost.fuelYuan.toFixed(0)} 元 + 过路费 ${r.cost.tollYuan.toFixed(0)} + 司机 ${r.cost.driverYuan.toFixed(0)} + 其他 ${r.cost.otherYuan.toFixed(0)} = 合计 ${r.cost.totalYuan.toFixed(0)} 元；柴油对比 ${r.cost.dieselYuan.toFixed(0)} 元，${r.cost.deltaYuan >= 0 ? '比柴油贵' : '比柴油省'} ${Math.abs(r.cost.deltaYuan).toFixed(0)} 元`)
    lines.push('')
  }
  lines.push('请给出推荐路线与原因（注意：两个模型结论不一致时要指出差异与取舍）。')
  return lines.join('\n')
}

export async function recommendRoute(
  input: RouteRecommendInput,
  config: AiConfig,
): Promise<{ text: string; model: string }> {
  const baseUrl = (config.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '')
  const model = config.model || 'deepseek-v4-flash'
  const r = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + config.apiKey,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: RECOMMEND_SYSTEM_PROMPT },
        { role: 'user', content: buildRecommendPrompt(input) },
      ],
      temperature: 0.3,
      max_tokens: 1200,
    }),
    signal: AbortSignal.timeout(60000),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error('AI 请求失败 HTTP ' + r.status + ': ' + t.slice(0, 300))
  }
  const j: any = await r.json()
  const text = j.choices?.[0]?.message?.content ?? ''
  if (!text) throw new Error('AI 返回内容为空：' + JSON.stringify(j).slice(0, 200))
  return { text, model }
}
