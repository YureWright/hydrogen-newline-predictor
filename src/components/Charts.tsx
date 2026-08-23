/** 轻量图表组件（零依赖 SVG/CSS，用于路段数据分析区） */
import { memo, useId, type ReactNode } from 'react'

const W = 760
const H = 220
const PAD = { l: 58, r: 18, t: 18, b: 40 }
/** 深色主题的网格线与坐标轴文字：压到刚好能看见，不跟数据线抢注意力 */
const GRID = 'rgba(255,255,255,0.06)'
const AXIS = '#6a7691'

/** 通用折线/面积图（x=km，y=数值） */
/** 通用折线/面积图（x=km，y=数值）；支持多系列对比（series），图例在左上角 */
function LineAreaChart({ points, color, yLabel, unit, markers, series }: {
  points: Array<{ x: number; y: number }>
  color: string
  yLabel: string
  unit: string
  markers?: Array<{ x: number; label: string; color?: string }>
  series?: Array<{ points: Array<{ x: number; y: number }>; color: string; label: string; dashed?: boolean }>
}) {
  // useId 必须在提前 return 之前调用，否则违反 Hook 规则；冒号在 url(#id) 里不安全，去掉
  const gradId = 'grad' + useId().replace(/:/g, '')
  const allSeries = series ?? [{ points, color, label: '' }]
  const allPts = allSeries.flatMap((s) => s.points)
  if (allPts.length < 2) return <div className="chart-empty">数据不足</div>
  const xs = allPts.map((p) => p.x)
  const ys = allPts.map((p) => p.y)
  const xMin = 0
  const xMax = Math.max(...xs)
  const yMin = Math.min(...ys)
  const yMax = Math.max(...ys)
  const yPad = Math.max((yMax - yMin) * 0.12, 1)
  const X = (x: number) => PAD.l + ((x - xMin) / Math.max(xMax - xMin, 1e-9)) * (W - PAD.l - PAD.r)
  const Y = (y: number) => H - PAD.b - ((y - (yMin - yPad)) / Math.max(yMax - yMin + 2 * yPad, 1e-9)) * (H - PAD.t - PAD.b)
  const pathOf = (pts: Array<{ x: number; y: number }>) =>
    pts.map((p, i) => (i ? 'L' : 'M') + X(p.x).toFixed(1) + ',' + Y(p.y).toFixed(1)).join(' ')
  const main = allSeries[0]
  const mainLine = pathOf(main.points)
  const area = mainLine + ' L' + X(xMax).toFixed(1) + ',' + (H - PAD.b) + ' L' + X(xMin).toFixed(1) + ',' + (H - PAD.b) + ' Z'
  const ticks = 4
  const xTicks: number[] = []
  for (let i = 0; i <= ticks; i++) xTicks.push((xMax * i) / ticks)
  const yTicks: number[] = []
  for (let i = 0; i <= 4; i++) yTicks.push(yMin - yPad + ((yMax - yMin + 2 * yPad) * i) / 4)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img">
      <defs>
        {/* 面积渐变：顶部带色、底部透明，深色底上比纯半透明填充更有纵深 */}
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={main.color} stopOpacity="0.34" />
          <stop offset="100%" stopColor={main.color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {allSeries.length > 1 && (
        <g>
          {allSeries.map((s, si) => (
            <g key={si} transform={`translate(${PAD.l + si * 132}, 12)`}>
              <rect x={0} y={-5} width={16} height={3} rx={1.5} fill={s.color} />
              <text x={20} y={-1} fontSize="10" fill={AXIS}>{s.label}</text>
            </g>
          ))}
        </g>
      )}
      {xTicks.map((t) => (
        <g key={'x' + t}>
          <line x1={X(t)} y1={PAD.t} x2={X(t)} y2={H - PAD.b} stroke={GRID} />
          <text x={X(t)} y={H - PAD.b + 16} fontSize="11" fill={AXIS} textAnchor="middle">{t.toFixed(0)}</text>
        </g>
      ))}
      {yTicks.map((t) => (
        <g key={'y' + t}>
          <line x1={PAD.l} y1={Y(t)} x2={W - PAD.r} y2={Y(t)} stroke={GRID} />
          <text x={PAD.l - 8} y={Y(t) + 4} fontSize="11" fill={AXIS} textAnchor="end">{t.toFixed(0)}</text>
        </g>
      ))}
      <path d={area} fill={`url(#${gradId})`} />
      {allSeries.map((s, si) => (
        <path
          key={si}
          d={pathOf(s.points)}
          fill="none"
          stroke={s.color}
          strokeWidth={si === 0 ? 2 : 1.8}
          strokeDasharray={s.dashed ? '6 4' : undefined}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={si === 0 ? 1 : 0.92}
          style={si === 0 ? { filter: `drop-shadow(0 0 5px ${s.color}80)` } : undefined}
        />
      ))}
      {allSeries.map((s, si) => (
        <g key={'pt' + si}>
          {[0, s.points.length - 1].map((i) => (
            <circle key={i} cx={X(s.points[i].x)} cy={Y(s.points[i].y)} r={si === 0 ? 3.4 : 2.8} fill={s.color} stroke="#04060c" strokeWidth="1.5" />
          ))}
        </g>
      ))}
      {(() => {
        const visible = markers?.filter((m) => m.x >= xMin && m.x <= xMax) ?? []
        let lastPx = -999
        return visible.map((m, i) => {
          const px = X(m.x)
          const tooClose = px - lastPx < 28
          if (!tooClose) lastPx = px
          return (
            <g key={'m' + i}>
              <line x1={px} y1={PAD.t} x2={px} y2={H - PAD.b} stroke={m.color ?? '#ff6072'} strokeDasharray="3 3" opacity="0.5" />
              {!tooClose && <text x={px} y={PAD.t + 10} fontSize="8" fill={m.color ?? '#ff6072'} textAnchor="middle">{m.label}</text>}
            </g>
          )
        })
      })()}
      <text x={W - PAD.r} y={PAD.t - 4} fontSize="10" fill={AXIS} textAnchor="end">{yLabel}（{unit}）</text>
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
