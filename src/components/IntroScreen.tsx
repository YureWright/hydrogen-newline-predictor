import { useMemo, useState } from 'react'

interface Props {
  onEnter: () => void
}

function generateStars(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    left: Math.random() * 100,
    top: Math.random() * 58,
    size: 1 + Math.random() * 2,
    delay: Math.random() * 6,
    duration: 2 + Math.random() * 3,
    opacity: 0.4 + Math.random() * 0.6,
  }))
}

export default function IntroScreen({ onEnter }: Props) {
  const [leaving, setLeaving] = useState(false)
  const stars = useMemo(() => generateStars(45), [])

  const leave = () => {
    if (leaving) return
    setLeaving(true)
    setTimeout(onEnter, 480)
  }

  return (
    <div
      className={'intro intro-galaxy' + (leaving ? ' intro-leave' : '')}
      role="dialog"
      aria-label="欢迎"
      onClick={leave}
    >
      <img className="intro-bg" src="/hero-hybot.png" alt="" aria-hidden="true" />

      <div className="intro-stars" aria-hidden="true">
        {stars.map(s => (
          <span
            key={s.id}
            className="intro-star"
            style={{
              left: `${s.left}%`,
              top: `${s.top}%`,
              width: `${s.size}px`,
              height: `${s.size}px`,
              animationDelay: `${s.delay}s`,
              animationDuration: `${s.duration}s`,
              opacity: s.opacity,
            }}
          />
        ))}
      </div>

      <div className="intro-headlight-glow" aria-hidden="true" />

      <div className="intro-energy-line" aria-hidden="true" />

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

      <div className="intro-hint">点击进入测算</div>
    </div>
  )
}
