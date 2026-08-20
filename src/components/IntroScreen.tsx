import { useState } from 'react'

interface Props {
  onEnter: () => void
}

/**
 * 首屏按标注重做：
 * - 左上直接贴官方 logo 原图（不重画字体）
 * - 绿色极光营地原图做整屏背景，去掉水印文字
 * - 天上极光做延时摄影式变幻
 * - 原图红色卡车位置盖上首页氢车
 */
export default function IntroScreen({ onEnter }: Props) {
  const [leaving, setLeaving] = useState(false)

  const leave = () => {
    if (leaving) return
    setLeaving(true)
    setTimeout(onEnter, 480)
  }

  return (
    <div
      className={'intro intro-photo' + (leaving ? ' intro-leave' : '')}
      role="dialog"
      aria-label="欢迎"
      onClick={leave}
    >
      <div className="intro-aurora" aria-hidden="true">
        <img className="intro-aurora-base" src="/aurora-camp.jpg" alt="" />
        <div className="intro-aurora-sky" />
        <div className="intro-aurora-sky intro-aurora-sky-b" />
      </div>

      <div className="intro-hero-truck" aria-hidden="true">
        <img src="/truck-cutout.png" alt="" />
      </div>

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
