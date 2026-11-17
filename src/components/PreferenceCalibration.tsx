/**
 * 偏好校准向导：
 * - 情景选择法：通过 6 道“时间换费用”题求临界费用差；
 * - 李克特量表：8 道题自动计分（含 2 道反向题）；
 * - 运营成本法：司机时薪 + 迟到罚款期望，用于客观校验。
 * 两种主观测量都完成后即时计算 λ，并可一键回填规划器。
 */
import { useState } from 'react'

interface Props {
  initialLambda?: number
  onApply: (lambda: number) => void
  onClose: () => void
}

type Mode = 'scenario' | 'scale'

const DIFFS = [20, 40, 60, 80, 100, 120]
const LIKERT_QUESTIONS = [
  { id: 'L1', text: '我宁愿多花点钱，也要保证按时送达', reverse: false },
  { id: 'L2', text: '只要不迟到，慢一点省钱更好', reverse: true },
  { id: 'L3', text: '客户对晚到非常敏感', reverse: false },
  { id: 'L4', text: '司机在途时间长，成本很高', reverse: false },
  { id: 'L5', text: '我愿意为每辆车每小时多付 50 元来省 1 小时', reverse: false },
  { id: 'L6', text: '我愿意为每辆车每小时多付 100 元来省 1 小时', reverse: false },
  { id: 'L7', text: '迟到一次的损失远大于多花的氢费', reverse: false },
  { id: 'L8', text: '我们更看重总成本，而不是绝对时效', reverse: true },
] as const

function numberOrZero(value: string): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, n) : 0
}

export default function PreferenceCalibration({ initialLambda, onApply, onClose }: Props) {
  const currentLambda = Math.round(initialLambda ?? 0)
  const [mode, setMode] = useState<Mode>('scenario')
  const [answers, setAnswers] = useState<Array<'A' | 'B' | null>>(Array(6).fill(null))
  const [scaleAnswers, setScaleAnswers] = useState<Array<number | null>>(Array(8).fill(null))
  const [driverRate, setDriverRate] = useState('60')
  const [latePenalty, setLatePenalty] = useState('0')

  const answered = answers.filter(Boolean).length
  const scaleAnswered = scaleAnswers.filter((v) => v != null).length
  const firstB = answers.findIndex((a) => a === 'B')
  // 全选 A → 0；出现 B → 该档费用差；全选 B → 120
  const scenario = firstB >= 0 ? DIFFS[firstB] : (answered === 6 ? 0 : null)
  const cost = numberOrZero(driverRate) + numberOrZero(latePenalty)

  const likertScore = scaleAnswered === LIKERT_QUESTIONS.length
    ? scaleAnswers.reduce<number>((sum, value, index) => {
        if (value == null) return sum
        return sum + (LIKERT_QUESTIONS[index].reverse ? 6 - value : value)
      }, 0)
    : null
  const scaleLambda = likertScore == null
    ? null
    : Math.round(((likertScore - 8) / 32) * 300)

  const primary = mode === 'scenario' ? scenario : scaleLambda
  const final = primary == null
    ? null
    : Math.round(cost > 0 ? 0.6 * primary + 0.4 * cost : primary)
  const clamped = final == null ? null : Math.min(300, Math.max(0, final))

  const setAnswer = (i: number, value: 'A' | 'B') => {
    setAnswers((prev) => prev.map((item, index) => (index === i ? value : item)))
  }

  const setScaleAnswer = (i: number, value: number) => {
    setScaleAnswers((prev) => prev.map((item, index) => (index === i ? value : item)))
  }

  return (
    <div className="calib-overlay" onClick={onClose}>
      <div className="calib-card" onClick={(e) => e.stopPropagation()}>
        <div className="calib-head">
          <b>🎯 偏好校准</b>
          <span className="calib-current">当前 λ：{currentLambda} 元/h</span>
          <button className="calib-close" onClick={onClose}>×</button>
        </div>

        <div className="calib-tabs">
          <button className={'calib-tab' + (mode === 'scenario' ? ' on' : '')} onClick={() => setMode('scenario')}>
            情景选择 · 推荐
          </button>
          <button className={'calib-tab' + (mode === 'scale' ? ' on' : '')} onClick={() => setMode('scale')}>
            快速量表 · 8 题
          </button>
        </div>

        {mode === 'scenario' ? (
          <>
            <p className="calib-tip">
              同一起终点、同一时段、同一货重。路线 A 便宜但慢，路线 B 贵但快，<b>时间差固定 1 小时</b>。
              请逐题选择你更愿意选的那条路线。
            </p>
            <div className="calib-rows">
              {DIFFS.map((difference, i) => (
                <div className="calib-row" key={difference}>
                  <span className="calib-q">Q{i + 1}</span>
                  <span className="calib-a">A：1000 元 / 8h</span>
                  <span className="calib-b">B：{1000 + difference} 元 / 7h（贵 {difference}）</span>
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
          </>
        ) : (
          <>
            <p className="calib-tip">
              请按真实运营习惯选择同意程度：<b>1 = 非常不同意，5 = 非常同意</b>。
              带“反向”的题目会自动反向计分，完成后即时换算 λ。
            </p>
            <div className="calib-likert">
              {LIKERT_QUESTIONS.map((question, i) => (
                <div className="calib-likert-row" key={question.id}>
                  <span className="calib-likert-statement">
                    <b>{question.id}</b> {question.text}
                    {question.reverse && <em>反向</em>}
                  </span>
                  <span className="calib-likert-opts">
                    {[1, 2, 3, 4, 5].map((value) => (
                      <button
                        key={value}
                        className={'calib-likert-opt' + (scaleAnswers[i] === value ? ' on' : '')}
                        onClick={() => setScaleAnswer(i, value)}
                        aria-label={`${question.id} 选择 ${value} 分`}
                      >{value}</button>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="calib-cost">
          <span className="calib-cost-label">运营成本校验（可选）</span>
          <label>司机时薪（元/h）<input inputMode="decimal" value={driverRate} onChange={(e) => setDriverRate(e.target.value)} /></label>
          <label>迟到罚款期望（元/h）<input inputMode="decimal" value={latePenalty} onChange={(e) => setLatePenalty(e.target.value)} /></label>
        </div>

        <div className="calib-result">
          {mode === 'scenario' && clamped == null && (
            <span>请完成 {6 - answered} 道情景题，系统会立即计算 λ。</span>
          )}
          {mode === 'scale' && clamped == null && (
            <span>已完成 {scaleAnswered}/8 题，完成后系统会立即计算 λ。</span>
          )}
          {mode === 'scenario' && clamped != null && (
            <>
              <span>情景法 λ = <b>{scenario}</b> 元/h</span>
              {cost > 0 && <span>运营成本法 λ = <b>{cost}</b> 元/h</span>}
              {scaleLambda != null && <span>快速量表交叉校验 = <b>{scaleLambda}</b> 元/h</span>}
              <span className="calib-final">最终 λ = <b>{clamped}</b> 元/h（≈ 每省 1 小时愿意多花 {clamped} 元）</span>
            </>
          )}
          {mode === 'scale' && clamped != null && (
            <>
              <span>量表总分 S = <b>{likertScore}</b> / 40</span>
              <span>量表法 λ = <b>{scaleLambda}</b> 元/h</span>
              {cost > 0 && <span>运营成本法 λ = <b>{cost}</b> 元/h</span>}
              {scenario != null && <span>情景选择交叉校验 = <b>{scenario}</b> 元/h</span>}
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
