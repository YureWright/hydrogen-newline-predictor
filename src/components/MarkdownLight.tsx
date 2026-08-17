/** 轻量 Markdown 渲染（AI 评估输出用）：支持标题/粗体/无序/有序/段落 */
import type { ReactNode } from 'react'

function inline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>,
  )
}

export default function MarkdownLight({ text }: { text: string }) {
  const lines = text.split(/\r?\n/)
  const out: ReactNode[] = []
  let list: ReactNode[] = []
  let listType = ''

  const flushList = (key: string) => {
    if (list.length) {
      out.push(
        listType === 'ol' ? (
          <ol key={key}>{list}</ol>
        ) : (
          <ul key={key}>{list}</ul>
        ),
      )
      list = []
      listType = ''
    }
  }

  lines.forEach((raw, idx) => {
    const line = raw.trim()
    if (!line) { flushList('p' + idx); return }
    const h = line.match(/^(#{1,4})\s+(.*)/)
    if (h) {
      flushList('h' + idx)
      const level = h[1].length + 2
      const Tag = ('h' + Math.min(level, 6)) as 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      out.push(<Tag key={'h' + idx}>{inline(h[2])}</Tag>)
      return
    }
    const ul = line.match(/^[-*]\s+(.*)/)
    if (ul) {
      if (listType !== 'ul') { flushList('s' + idx); listType = 'ul' }
      list.push(<li key={idx}>{inline(ul[1])}</li>)
      return
    }
    const ol = line.match(/^\d+[.、]\s+(.*)/)
    if (ol) {
      if (listType !== 'ol') { flushList('s' + idx); listType = 'ol' }
      list.push(<li key={idx}>{inline(ol[1])}</li>)
      return
    }
    flushList('s' + idx)
    out.push(<p key={'p' + idx}>{inline(line)}</p>)
  })
  flushList('end')
  return <div className="md-body">{out}</div>
}
