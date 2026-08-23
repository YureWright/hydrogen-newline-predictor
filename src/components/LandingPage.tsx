import { useCallback } from 'react'

interface Props {
  onStart: () => void
}

export default function LandingPage({ onStart }: Props) {
  const openDocs = useCallback(() => {
    window.open('/?view=docs', '_blank')
  }, [])

  return (
    <div className="landing">
      {/* 全屏背景（官网原图，无文字版） */}
      <div className="landing-bg" />

      {/* 银河闪烁星点 */}
      <div className="stars-layer" aria-hidden="true">
        {Array.from({ length: 45 }, (_, i) => (
          <i key={i} className={`star st${i}`} />
        ))}
      </div>


      {/* logo（左上，和官网同位置） */}
      <img className="landing-logo" src="/logo-hybot.png" alt="hybot 海珀特" />

      {/* 标语（左侧，和官网同位置） */}
      <div className="landing-slogan">
        <h2>以<em>氢能</em>创造无限可能</h2>
        <p>Hydrogen Powering Infinity</p>
      </div>

      {/* 底部：队名 + 按钮，放一起确保对齐 */}
      <div className="landing-bottom-group">
        <div className="team-name">
          <span className="team-label">队伍名称</span>
          <span className="team-text">氢氢敲醒沉睡的新能源车</span>
        </div>
        <div className="landing-btns">
          <button className="landing-btn-sm landing-btn-primary" onClick={onStart}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M13 3L4 14h7l-2 7 9-11h-7l2-7z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            开始预测氢耗
          </button>
          <button className="landing-btn-sm landing-btn-docs" onClick={openDocs}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            技术文档
          </button>
        </div>
      </div>

      <span className="landing-tag">T05 · 氢能黑客松</span>
    </div>
  )
}
