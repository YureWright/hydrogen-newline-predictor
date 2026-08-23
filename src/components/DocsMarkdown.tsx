/** 文档库 Markdown 渲染：标题/粗体/斜体/行内代码/列表/表格/代码块/引用/链接/段落（知识库与 docs 用） */
import type { ReactNode } from 'react'

/** 行内解析：**粗体** *斜体* `代码` [文字](链接) 自动转义其余 HTML */
function inline(text: string, keyBase: string): ReactNode[] {
  const tokens: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text))) {
    if (m.index > last) tokens.push(<span key={keyBase + '_t' + i++}>{esc(text.slice(last, m.index))}</span>)
    const tok = m[0]
    if (tok.startsWith('**')) tokens.push(<strong key={keyBase + '_b' + i++}>{esc(tok.slice(2, -2))}</strong>)
    else if (tok.startsWith('*')) tokens.push(<em key={keyBase + '_e' + i++}>{esc(tok.slice(1, -1))}</em>)
    else if (tok.startsWith('`')) tokens.push(<code key={keyBase + '_c' + i++}>{esc(tok.slice(1, -1))}</code>)
    else {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)
      if (mm) tokens.push(<a key={keyBase + '_a' + i++} href={mm[2]} target="_blank" rel="noreferrer">{esc(mm[1])}</a>)
    }
    last = m.index + tok.length
  }
  if (last < text.length) tokens.push(<span key={keyBase + '_z' + i++}>{esc(text.slice(last))}</span>)
  return tokens
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 代码块内容原样展示（不转义，用 CSS 控制） */
function CodeBlock({ code }: { code: string }) {
  return <pre className="doc-code"><code>{code.replace(/\n$/, '')}</code></pre>
}

export default function DocsMarkdown({ text }: { text: string }) {
  const lines = text.split(/\r?\n/)
  const out: ReactNode[] = []
  let idx = 0

  const flushList = (key: string, ordered: boolean, items: ReactNode[]) => {
    if (items.length) out.push(ordered ? <ol key={'ol' + key}>{items}</ol> : <ul key={'ul' + key}>{items}</ul>)
  }

  while (idx < lines.length) {
    const line = lines[idx]
    // 代码块
    if (/^```/.test(line.trim())) {
      const buf: string[] = []
      idx++
      while (idx < lines.length && !/^```/.test(lines[idx].trim())) { buf.push(lines[idx]); idx++ }
      idx++
      out.push(<CodeBlock key={'code' + out.length} code={buf.join('\n')} />)
      continue
    }
    // 表格（连续 | 行，第二行是分隔）
    if (line.trim().startsWith('|') && idx + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[idx + 1])) {
      const rows: string[][] = []
      while (idx < lines.length && lines[idx].trim().startsWith('|')) {
        const cells = lines[idx].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
        if (!/^[\s:|-]+$/.test(cells.join(''))) rows.push(cells)
        idx++
      }
      if (rows.length) {
        const head = rows[0]
        const body = rows.slice(1)
        out.push(
          <div className="doc-table" key={'tbl' + out.length}>
            <table>
              <thead><tr>{head.map((h, j) => <th key={j}>{inline(h, 'th' + j)}</th>)}</tr></thead>
              {body.length > 0 && <tbody>{body.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{inline(c, 'td' + i + '_' + j)}</td>)}</tr>)}</tbody>}
            </table>
          </div>,
        )
      }
      continue
    }
    // 标题
    const hm = /^(#{1,6})\s+(.*)$/.exec(line)
    if (hm) {
      const lv = hm[1].length
      const H = ('h' + Math.min(lv + 1, 6)) as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      out.push(<H key={'h' + out.length} className={'doc-h doc-h' + lv}>{inline(hm[2], 'hi' + out.length)}</H>)
      idx++
      continue
    }
    // 列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: ReactNode[] = []
      let k = 0
      while (idx < lines.length && /^\s*[-*+]\s+/.test(lines[idx])) {
        items.push(<li key={k++}>{inline(lines[idx].replace(/^\s*[-*+]\s+/, ''), 'li' + out.length + '_' + k)}</li>)
        idx++
      }
      flushList('l' + out.length, false, items)
      continue
    }
    if (/^\s*\d+[.、]\s+/.test(line)) {
      const items: ReactNode[] = []
      let k = 0
      while (idx < lines.length && /^\s*\d+[.、]\s+/.test(lines[idx])) {
        items.push(<li key={k++}>{inline(lines[idx].replace(/^\s*\d+[.、]\s+/, ''), 'oli' + out.length + '_' + k)}</li>)
        idx++
      }
      flushList('ol' + out.length, true, items)
      continue
    }
    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = []
      while (idx < lines.length && /^\s*>\s?/.test(lines[idx])) { buf.push(lines[idx].replace(/^\s*>\s?/, '')); idx++ }
      out.push(<blockquote key={'q' + out.length}>{inline(buf.join(' '), 'q' + out.length)}</blockquote>)
      continue
    }
    // 空行
    if (/^\s*$/.test(line)) { idx++; continue }
    // 段落（合并连续非空非特殊行）
    const buf: string[] = [line]
    idx++
    while (idx < lines.length && !/^\s*$/.test(lines[idx]) && !/^(#{1,6}\s|```|\s*[-*+]\s|\s*\d+[.、]\s|\s*>\s?|\s*\|)/.test(lines[idx])) {
      buf.push(lines[idx]); idx++
    }
    out.push(<p key={'p' + out.length}>{inline(buf.join(' '), 'p' + out.length)}</p>)
  }
  return <div className="doc-md">{out}</div>
}
