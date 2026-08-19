/**
 * AI 路线评估模块（Node 侧，供 vite 中间件调用）
 *
 * 配置（环境变量 / .env，均为服务端，不进入浏览器）：
 *   DEEPSEEK_API_KEY  必填
 *   DEEPSEEK_BASE_URL 可选，默认 https://api.deepseek.com（OpenAI 兼容端点）
 *   DEEPSEEK_MODEL    可选，默认 deepseek-v4-flash
 */
import type { RouteCandidate, SegmentData, SegmentSummary } from './types'

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
  lines.push(`共 ${s.segmentCount} 段；高速 ${s.roadLevelKm.highway}km，国道 ${s.roadLevelKm.national}km，省道 ${s.roadLevelKm.provincial}km，城市 ${s.roadLevelKm.city}km，其他 ${s.roadLevelKm.other}km`)
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
