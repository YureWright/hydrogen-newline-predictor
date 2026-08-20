import { useEffect, useState } from 'react'
import Hero3D from './Hero3D'

interface Props {
  onEnter: () => void
}

/**
 * 首屏：Three.js 透视场景里氢车从远处冲来，铺满画面后再拉远定格。
 * 定格后等用户点击才进主页（方便路演给队友看完这一镜）。
 */
export default function IntroScreen({ onEnter }: Props) {
  const reducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const [phase, setPhase] = useState<'rush' | 'hold'>(reducedMotion ? 'hold' : 'rush')
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    if (reducedMotion) return
    const t = setTimeout(() => setPhase('hold'), 4200)
    return () => clearTimeout(t)
  }, [reducedMotion])

  const leave = () => {
    if (leaving) return
    setLeaving(true)
    setTimeout(onEnter, 520)
  }

  const onStageClick = () => {
    if (phase === 'rush') setPhase('hold')
    else leave()
  }

  return (
    <div
      className={'intro intro-3d' + (leaving ? ' intro-leave' : '') + (phase === 'hold' ? ' intro-hold' : '')}
      role="dialog"
      aria-label="欢迎"
      onClick={onStageClick}
    >
      <Hero3D phase={phase} reducedMotion={reducedMotion} />
      <div className="intro-vignette" aria-hidden="true" />
      <div className="intro-scan" aria-hidden="true" />

      <div className="intro-brand" onClick={(e) => e.stopPropagation()}>
        <img className="intro-logo" src="/hybot-logo.png" alt="hybot 海珀特" />
        <div className="intro-slogan">
          <p className="intro-slogan-cn">以氢能创造无限可能</p>
          <p className="intro-slogan-en"><em>Hydrogen</em> Powering Infinity</p>
        </div>
      </div>

      <button
        className="intro-skip"
        onClick={(e) => { e.stopPropagation(); leave() }}
        aria-label="跳过引导"
      >跳过 →</button>

      <div className="intro-hint" onClick={onStageClick}>
        {phase === 'rush' ? '冲过来… 点一下可直接定格' : '点击进入测算'}
      </div>
    </div>
  )
}
