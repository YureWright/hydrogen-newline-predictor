import { useMemo, useState } from 'react'

interface Props {
  onEnter: () => void
}

interface Star {
  id: number
  left: number
  top: number
  size: number
  delay: number
  duration: number
  type: 'bright' | 'medium' | 'regular'
}

function generateStars(count: number): Star[] {
  return Array.from({ length: count }, (_, i) => {
    const isBright = i < 5
    const isMedium = !isBright && i < 17
    return {
      id: i,
      left: Math.random() * 100,
      top: Math.random() * 55,
      size: isBright
        ? 3 + Math.random() * 2
        : isMedium
          ? 2 + Math.random() * 1.5
          : 1 + Math.random() * 1.5,
      delay: Math.random() * 6,
      duration: isBright ? 1.8 + Math.random() * 1.5 : 2 + Math.random() * 3,
      type: isBright ? 'bright' : isMedium ? 'medium' : 'regular',
    }
  })
}

export default function IntroScreen({ onEnter }: Props) {
  const [leaving, setLeaving] = useState(false)
  const stars = useMemo(() => generateStars(55), [])

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
            className={`intro-star${s.type !== 'regular' ? ` intro-star-${s.type}` : ''}`}
            style={{
              left: `${s.left}%`,
              top: `${s.top}%`,
              width: `${s.size}px`,
              height: `${s.size}px`,
              animationDelay: `${s.delay}s`,
              animationDuration: `${s.duration}s`,
            }}
          />
        ))}
      </div>

      <div className="intro-headlight-fog" aria-hidden="true">
        <div className="intro-hl intro-hl-r" />
        <div className="intro-hl intro-hl-l" />
      </div>

      <div className="intro-energy-line" aria-hidden="true" />

      <div className="intro-brand" onClick={(e) => e.stopPropagation()}>
        <img className="intro-logo" src="/hybot-logo.png" alt="hybot 海珀特" />
        <div className="intro-slogan">
          <p className="intro-slogan-cn">以氢能创造无限可能</p>
          <p className="intro-slogan-en"><em>Hydrogen</em> Powering Infinity</p>
        </div>
      </div>

      <p className="intro-tagline">让每克氢都跑在刀刃上</p>

      <button
        className="intro-skip"
        onClick={(e) => { e.stopPropagation(); leave() }}
        aria-label="跳过引导"
      >跳过 →</button>

      <div className="intro-hint">点击进入测算</div>
    </div>
  )
}
