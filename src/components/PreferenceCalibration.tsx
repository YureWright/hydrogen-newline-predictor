/**
 * 偏好校准向导：6 道情景选择题 + 可选的运营成本输入 → 计算时间价值 λ（元/小时）
 * 情景法：找到从"选便宜"转为"选快"的临界费用差（时间差固定 1 小时）
 */
import { useState } from 'react'

interface Props {
  initialLambda?: number
  onApply: (lambda: number) => void
  onClose: () => void
}

const DIFFS = [20, 40, 60, 80, 100, 120]

export default function PreferenceCalibration({ initialLambda, onApply, onClose }: Props) {
  const currentLambda = Math.round(initialLambda ?? 0)
  const [answers, setAnswers] = useState<Array<'A' | 'B' | null>>(Array(6).fill(null))
  const [driverRate, setDriverRate] = useState('60')
  const [latePenalty, setLatePenalty] = useState('0')

  const answered = answers.filter(Boolean).length
  const firstB = answers.findIndex((a) => a === 'B')
  // 全选 A → 0；出现 B → 该档费用差；全选 B → 120
  const scenario = firstB >= 0 ? DIFFS[firstB] : (answered === 6 ? 0 : null)
  const cost = Math.max(0, Number(driverRate || 0)) + Math.max(0, Number(latePenalty || 0))
  const final = scenario == null
    ? null
    : Math.round(cost > 0 ? 0.6 * scenario + 0.4 * cost : scenario)
  const clamped = final == null ? null : Math.min(300, Math.max(0, final))

  const setAnswer = (i: number, v: 'A' | 'B') => {
    setAnswers((prev) => prev.map((x, j) => (j === i ? v : x)))
  }

  return (
    <div className="calib-overlay" onClick={onClose}>
      <div className="calib-card" onClick={(e) => e.stopPropagation()}>
        <div className="calib-head">
          <b>🎯 偏好校准</b>
          <span className="calib-current">当前 λ：{currentLambda} 元/h</span>
          <button className="calib-close" onClick={onClose}>×</button>
        </div>
        <p className="calib-tip">
          同一起终点、同一时段、同一货重。路线 A 便宜但慢，路线 B 贵但快，<b>时间差固定 1 小时</b>。
          请逐题选择你更愿意选的那条路线。
        </p>

        <div className="calib-rows">
          {DIFFS.map((d, i) => (
            <div className="calib-row" key={i}>
              <span className="calib-q">Q{i + 1}</span>
              <span className="calib-a">A：1000 元 / 8h</span>
              <span className="calib-b">B：{1000 + d} 元 / 7h（贵 {d}）</span>
              <span className="calib-opts">
                <button
                  className={'calib-opt' + (answers[i] === 'A' ? ' on' : '')}
                  onClick={() => setAnswer(i, 'A')}
                >A</button>
                <button
                  className={'calib-opt' + (answers[i] === 'B' ? ' on' : '')}
                  onClick={() => setAnswer(i, 'B')}
                >B</button>
              </span>
            </div>
          ))}
        </div>

        <div className="calib-cost">
          <label>司机时薪（元/h）<input value={driverRate} onChange={(e) => setDriverRate(e.target.value)} /></label>
          <label>迟到罚款期望（元/h）<input value={latePenalty} onChange={(e) => setLatePenalty(e.target.value)} /></label>
        </div>

        <div className="calib-result">
          {clamped == null ? (
            <span>请完成 {6 - answered} 道情景题</span>
          ) : (
            <>
              <span>情景法 λ = <b>{scenario}</b> 元/h</span>
              {cost > 0 && <span>成本法 λ = <b>{cost}</b> 元/h</span>}
              <span className="calib-final">最终 λ = <b>{clamped}</b> 元/h（≈ 每省 1 小时愿意多花 {clamped} 元）</span>
            </>
          )}
        </div>

        <div className="calib-actions">
          <button className="btn-back" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={clamped == null} onClick={() => clamped != null && onApply(clamped)}>
            应用 λ
          </button>
        </div>
      </div>
    </div>
  )
}
