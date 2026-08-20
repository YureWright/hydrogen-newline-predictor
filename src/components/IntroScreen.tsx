import { useEffect, useRef, useState } from 'react'

interface Props {
  onEnter: () => void
}

/**
 * 首屏引导动画：整车从画面深处驶入 → 大字 + 按钮浮出 → 点击后车驶出、覆盖层消失 → 露出主 App。
 *
 * 三个 stage 完全靠 CSS 类切换，React 只负责推进状态机；具体的位移/缩放/淡入淡出
 * 全交给 CSS transition，浏览器合成器出帧，避免 rAF 手写补间的抖动。
 *
 * 关键节奏（都写在 styles.css）：
 *   stage='approaching' → 车 900ms 从远处放大到停位；末段减速，模拟"进站"的停顿感
 *   stage='ready'       → 文案 + 按钮 500ms 淡入 + 上抬
 *   stage='leaving'     → 点击后车 900ms 向右加速驶出 + 头灯拖尾；同时整屏淡出交给主 App
 */
export default function IntroScreen({ onEnter }: Props) {
  const [stage, setStage] = useState<'approaching' | 'ready' | 'leaving'>('approaching')
  const rootRef = useRef<HTMLDivElement>(null)

  // 900ms 进站结束才允许点击按钮 —— 用状态机推进，不用 setTimeout 里手动改 CSS，
  // 因为组件被卸载时如果没清理定时器就会 setState on unmounted，React 会警告。
  useEffect(() => {
    const t = setTimeout(() => setStage((s) => (s === 'approaching' ? 'ready' : s)), 900)
    return () => clearTimeout(t)
  }, [])

  const enter = () => {
    if (stage !== 'ready') return
    setStage('leaving')
    // 车驶出 + 覆盖层淡出总时长 900ms，动画完再通知父组件卸载覆盖层，避免卸载瞬间闪一下
    setTimeout(onEnter, 900)
  }

  return (
    <div ref={rootRef} className={'intro intro-' + stage} role="dialog" aria-label="欢迎">
      <div className="intro-bg" aria-hidden="true" />
      <div className="intro-truck" aria-hidden="true">
        <div className="intro-truck-img" />
        {/* 头灯拖尾：驶入时头灯朝屏内、驶出时朝屏外，用 CSS 透明度控制显隐 */}
        <div className="intro-headlight" />
      </div>
      <div className="intro-copy">
        <div className="intro-eyebrow">HYBOT · H49 燃料电池半挂牵引车</div>
        <h1 className="intro-title">开始预测氢耗</h1>
        <p className="intro-sub">真实路网 · DEM 坡度剖面 · 沿线逐段天气 —— 三分钟给出一条新线路的氢耗账单</p>
        <button className="intro-cta" onClick={enter} disabled={stage !== 'ready'}>
          <span>启动测算</span>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {/* 兜底出口：动画卡住或用户想跳过时能立刻进主页 */}
        <button className="intro-skip" onClick={() => { setStage('leaving'); setTimeout(onEnter, 300) }}>跳过引导</button>
      </div>
    </div>
  )
}
