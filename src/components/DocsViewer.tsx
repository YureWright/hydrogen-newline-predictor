/** 文档库（新窗口 /?view=docs）：左导航分类 + 顶部 tab（共享窗口多文档）+ 内容区
 *  内容支持：技术原理双 Tab / Markdown 文档 / 设计文档 iframe */
import { useState } from 'react'
import { DOC_GROUPS, mdFiles, type DocEntry } from '../docsIndex'
import DocsMarkdown from './DocsMarkdown'
import TechTabs from './TechTabs'

const TECH_ENTRY: DocEntry = { id: 'tech', title: '⚡ 技术原理（ML + 物理模型）', kind: 'tech', hint: '机器学习与物理模型双 Tab 完整原理' }

export default function DocsViewer() {
  const [tabs, setTabs] = useState<DocEntry[]>([TECH_ENTRY])
  const [active, setActive] = useState('tech')

  const open = (e: DocEntry) => {
    setTabs((prev) => (prev.some((t) => t.id === e.id) ? prev : [...prev, e]))
    setActive(e.id)
  }
  const close = (id: string) => {
    const next = tabs.filter((t) => t.id !== id)
    setTabs(next.length ? next : [TECH_ENTRY])
    if (active === id) setActive(next.length ? next[next.length - 1].id : 'tech')
  }

  const entry = tabs.find((t) => t.id === active) ?? TECH_ENTRY

  return (
    <div className="docs-viewer">
      <aside className="docs-nav">
        <div className="docs-nav-title">📚 文档库</div>
        <div className="docs-nav-scroll">
          {DOC_GROUPS.map((g) => (
            <div className="docs-nav-group" key={g.group}>
              <div className="docs-nav-group-title">{g.group}</div>
              {g.items.map((item) => (
                <button
                  key={item.id}
                  className={'docs-nav-item' + (active === item.id ? ' on' : '')}
                  onClick={() => open(item)}
                  title={item.hint || item.title}
                >
                  {item.title}
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <div className="docs-main">
        <div className="docs-tabs">
          {tabs.map((t) => (
            <div key={t.id} className={'docs-tab' + (active === t.id ? ' on' : '')} onClick={() => setActive(t.id)} title={t.hint}>
              <span className="docs-tab-label">{t.title}</span>
              <button className="docs-tab-close" onClick={(e) => { e.stopPropagation(); close(t.id) }} title="关闭">✕</button>
            </div>
          ))}
          {tabs.length < 2 && <span className="docs-tabs-hint">点击左侧文档打开新标签页 · 全部共享本窗口</span>}
        </div>
        <div className="docs-content">
          {entry.kind === 'tech' && <TechTabs />}
          {entry.kind === 'html' && (
            <iframe className="docs-iframe" src={entry.htmlSrc} title={entry.title} />
          )}
          {entry.kind === 'md' && (
            <DocsMarkdown text={mdFiles[entry.globKey ?? ''] ?? '文档未找到（打包路径可能变化）'} />
          )}
        </div>
      </div>
    </div>
  )
}
