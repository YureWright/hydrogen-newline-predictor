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
      {/* 顶部氛围光 */}
      <div className="landing-glow" aria-hidden="true" />

      {/* 流动光带 */}
      <div className="light-strip strip-1" aria-hidden="true" />
      <div className="light-strip strip-2" aria-hidden="true" />
      <div className="light-strip strip-3" aria-hidden="true" />

      {/* 头图区 */}
      <div className="landing-hero">
        <div className="landing-hero-img" />
        <div className="landing-scanline" aria-hidden="true" />
        <div className="landing-hero-fade" aria-hidden="true" />
      </div>

      {/* 主内容 */}
      <div className="landing-body">
        <div className="landing-rule" />
        <h1 className="landing-title">新线路氢耗预测工具</h1>
        <p className="landing-sub">
          面向 H49 燃料电池半挂牵引车 · 真实路网道路等级 / DEM 坡度剖面 / 沿线逐段天气
        </p>

        <div className="landing-chips">
          <span><b>OSM</b> 真实路网</span>
          <span><b>DEM</b> 高程剖面</span>
          <span><b>QWeather</b> 沿线天气</span>
          <span><b>DeepSeek</b> AI 评估</span>
        </div>

        {/* 两个大按钮 */}
        <div className="landing-actions">
          <button className="landing-btn landing-btn-primary" onClick={onStart}>
            <span className="landing-btn-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M13 3L4 14h7l-2 7 9-11h-7l2-7z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </span>
            <span className="landing-btn-text">
              <strong>开始预测氢耗</strong>
              <small>输入起终点，获取全路线氢耗预测</small>
            </span>
            <span className="landing-btn-arrow">→</span>
          </button>

          <button className="landing-btn landing-btn-docs" onClick={openDocs}>
            <span className="landing-btn-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M8 7h8M8 11h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </span>
            <span className="landing-btn-text">
              <strong>技术文档</strong>
              <small>README / 技术原理 / 设计文档 / 知识库</small>
            </span>
            <span className="landing-btn-arrow">→</span>
          </button>
        </div>
      </div>

      <span className="landing-tag">T05 · 氢能黑客松</span>
      <div className="landing-footer">
        基于物理驱动 + 数据驱动融合模型 · Hydrogen Powering Infinity
      </div>
    </div>
  )
}
