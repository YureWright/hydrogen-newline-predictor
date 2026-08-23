/** 技术原理 · overlay 壳（双 Tab 内容在 TechTabs，文档库按钮新窗口） */
import TechTabs from './TechTabs'

export default function HydrogenHowItWorks({ onClose }: { onClose: () => void }) {
  return (
    <div className="howitworks-overlay" onClick={onClose}>
      <div className="howitworks-panel" onClick={(e) => e.stopPropagation()}>
        <div className="howitworks-head">
          <h3>⚡ 氢能消耗预测 · 技术原理</h3>
          <div className="howitworks-head-actions">
            <button className="btn-ai" onClick={() => window.open('/?view=docs', '_blank')} title="全部重要文档在新窗口打开（README/工作日志/设计文档/知识库）">📚 文档库</button>
            <button className="btn-close" onClick={onClose} title="关闭">✕</button>
          </div>
        </div>
        <div className="howitworks-body">
          <TechTabs />
        </div>
        <div className="howitworks-foot">
          <span>模型：HistGB · 按行程分组 CV · R²≈0.385（每折平均） · 数据/相关性/报告均为实测 · 物理引擎：能量守恒四阻力 → 电堆效率 → 氢耗（中间变量全透明）</span>
          <button className="btn-primary" onClick={onClose}>知道了</button>
        </div>
      </div>
    </div>
  )
}
