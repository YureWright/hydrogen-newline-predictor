/** 轻量图表组件（零依赖 SVG/CSS，用于路段数据分析区） */
import { memo, type ReactNode } from 'react'

const W = 760
const H = 200
const PAD = { l: 46, r: 14, t: 18, b: 28 }

/** 通用折线/面积图（x=km，y=数值） */
function LineAreaChart({ points, color, yLabel, unit, markers }: {
  points: Array<{ x: number; y: number }>
  color: string
  yLabel: string
  unit: string
  markers?: Array<{ x: number; label: string; color?: string }>
}) {
  if (points.length < 2) return <div className="chart-empty">数据不足</div>
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const xMin = 0
  const xMax = Math.max(...xs)
  const yMin = Math.min(...ys)
  const yMax = Math.max(...ys)
  const yPad = Math.max((yMax - yMin) * 0.12, 1)
  const X = (x: number) => PAD.l + ((x - xMin) / Math.max(xMax - xMin, 1e-9)) * (W - PAD.l - PAD.r)
  const Y = (y: number) => H - PAD.b - ((y - (yMin - yPad)) / Math.max(yMax - yMin + 2 * yPad, 1e-9)) * (H - PAD.t - PAD.b)
  const line = points.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ',' + Y(p.y).toFixed(1)).join(' ')
  const area = line + ' L' + X(xMax).toFixed(1) + ',' + (H - PAD.b) + ' L' + X(xMin).toFixed(1) + ',' + (H - PAD.b) + ' Z'
  const ticks = 4
  const xTicks: number[] = []
  for (let i = 0; i <= ticks; i++) xTicks.push((xMax * i) / ticks)
  const yTicks: number[] = []
  for (let i = 0; i <= 4; i++) yTicks.push(yMin - yPad + ((yMax - yMin + 2 * yPad) * i) / 4)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img">
      {xTicks.map((t) => (
        <g key={'x' + t}>
          <line x1={X(t)} y1={PAD.t} x2={X(t)} y2={H - PAD.b} stroke="#e8efe9" />
          <text x={X(t)} y={H - 8} fontSize="10" fill="#889" textAnchor="middle">{t.toFixed(0)}</text>
        </g>
      ))}
      {yTicks.map((t) => (
        <g key={'y' + t}>
          <line x1={PAD.l} y1={Y(t)} x2={W - PAD.r} y2={Y(t)} stroke="#e8efe9" />
          <text x={PAD.l - 6} y={Y(t) + 3} fontSize="10" fill="#889" textAnchor="end">{t.toFixed(0)}</text>
        </g>
      ))}
      <path d={area} fill={color} opacity="0.18" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      {[0, points.length - 1].map((i) => (
        <circle key={i} cx={X(points[i].x)} cy={Y(points[i].y)} r="3.2" fill={color} />
      ))}
      {markers?.filter((m) => m.x >= xMin && m.x <= xMax).map((m, i) => (
        <g key={'m' + i}>
          <line x1={X(m.x)} y1={PAD.t} x2={X(m.x)} y2={H - PAD.b} stroke={m.color ?? '#d62728'} strokeDasharray="3 3" opacity="0.65" />
          <text x={X(m.x)} y={H - 14} fontSize="9" fill={m.color ?? '#d62728'} textAnchor="middle">{m.label}</text>
        </g>
      ))}
      <text x={W - PAD.r} y={PAD.t - 4} fontSize="10" fill="#667" textAnchor="end">{yLabel}（{unit}）</text>
    </svg>
  )
}

/** CSS 横向分布条（道路等级 / 路况） */
function DistributionBars({ items, total, unit }: {
  items: Array<{ label: string; value: number; color: string }>
  total: number
  unit: string
}): ReactNode {
  const t = total > 0 ? total : 1
  return (
    <div className="dist-bars">
      {items.filter((i) => i.value > 0).map((i) => (
        <div className="dist-row" key={i.label}>
          <span className="dist-label">{i.label}</span>
          <div className="dist-track">
            <div className="dist-fill" style={{ width: `${(i.value / t) * 100}%`, background: i.color }} />
          </div>
          <span className="dist-value">{i.value.toFixed(1)}{unit}</span>
        </div>
      ))}
    </div>
  )
}

/** 堆叠条 + 图例（用于实时路况） */
function StackedBar({ items }: { items: Array<{ label: string; value: number; color: string }> }) {
  const total = items.reduce((a, b) => a + b.value, 0) || 1
  return (
    <div>
      <div className="stacked-track">
        {items.map((i) => (
          <div key={i.label} className="stacked-seg" style={{ width: `${(i.value / total) * 100}%`, background: i.color }} title={`${i.label} ${i.value}km`} />
        ))}
      </div>
      <div className="stacked-legend">
        {items.map((i) => (
          <span key={i.label}><i style={{ background: i.color }} />{i.label} {i.value.toFixed(1)}km</span>
        ))}
      </div>
    </div>
  )
}

/** React.memo：勾选/排序等高频交互不重算 SVG 路径 */
export const LineAreaChartMemo = memo(LineAreaChart)
export const DistributionBarsMemo = memo(DistributionBars)
export const StackedBarMemo = memo(StackedBar)
