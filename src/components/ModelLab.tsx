import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchJson } from '../lib/fetchJson'

/** 模型工坊 / 评测中心（2026-08-28）：
 *  模型：列表 / 导入(zip) / 试工
 *  评测集：列表 / 新建 / 追加 / 下载
 *  排行榜：按评测集展示（首次约3~4分钟，服务端缓存5分钟）
 *  服务器上写操作需要上传口令（UPLOAD_TOKEN），本地未配置则免口令。
 */

type Tab = 'models' | 'evalsets' | 'leaderboard'

const TOKEN_KEY = 'h2-upload-token'

function readFileB64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => {
      const b64 = String(fr.result || '').split(',')[1] || ''
      res(b64)
    }
    fr.onerror = () => rej(fr.error)
    fr.readAsDataURL(file)
  })
}
function readFileText(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result || ''))
    fr.onerror = () => rej(fr.error)
    fr.readAsText(file, 'utf-8')
  })
}

interface ModelInfo { id: string; name: string; version?: string; builtin?: boolean; valid: boolean }
interface EvalInfo { id: string; name: string; n_rows: number; source?: string }
interface LbRow { rank?: number; model: string; name: string; builtin?: boolean; mae_kg?: number; rmse_kg?: number; r2?: number; n?: number; error?: string; cached?: boolean }

export default function ModelLab() {
  const [tab, setTab] = useState<Tab>('models')
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) || '')
  const [needToken, setNeedToken] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [evalsets, setEvalsets] = useState<EvalInfo[]>([])
  const [lb, setLb] = useState<LbRow[] | null>(null)
  const [lbEval, setLbEval] = useState('')
  const [lbLoading, setLbLoading] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const modelZipRef = useRef<HTMLInputElement>(null)
  const evalCsvRef = useRef<HTMLInputElement>(null)
  const appendCsvRef = useRef<HTMLInputElement>(null)

  const headers = useCallback(() => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token) h['x-upload-token'] = token
    return h
  }, [token])

  const refreshModels = useCallback(async () => {
    const j = await fetchJson<any>('/api/models')
    if (j.ok) setModels(j.models || [])
  }, [])
  const refreshEvalsets = useCallback(async () => {
    const j = await fetchJson<any>('/api/evalsets')
    if (j.ok) setEvalsets(j.evalsets || [])
  }, [])

  useEffect(() => { refreshModels(); refreshEvalsets() }, [refreshModels, refreshEvalsets])

  const handle401 = (j: any) => {
    if (j && j.needToken) { setNeedToken(true); return true }
    return false
  }

  const importModel = useCallback(async () => {
    const f = modelZipRef.current?.files?.[0]
    if (!f) { setErr('请选择模型 zip 文件'); return }
    setBusy('正在上传并试工模型…'); setErr(''); setMsg('')
    try {
      const data = await readFileB64(f)
      const j = await fetchJson<any>('/api/models/import', { method: 'POST', headers: headers(), body: JSON.stringify({ data }) })
      if (handle401(j)) { setBusy(''); return }
      setMsg(j.msg || (j.ok ? '导入成功' : '导入失败'))
      setBusy('')
      if (j.ok) { refreshModels(); if (modelZipRef.current) modelZipRef.current.value = '' }
    } catch (e: any) { setErr('导入出错：' + (e.message || e)); setBusy('') }
  }, [headers, refreshModels])

  const createEval = useCallback(async () => {
    const f = evalCsvRef.current?.files?.[0]
    const id = (document.getElementById('evalId') as HTMLInputElement)?.value?.trim()
    const name = (document.getElementById('evalName') as HTMLInputElement)?.value?.trim()
    const src = (document.getElementById('evalSrc') as HTMLInputElement)?.value?.trim()
    if (!f) { setErr('请选择评测集 CSV'); return }
    if (!id || !name) { setErr('请填写评测集 id 和名称'); return }
    setBusy('正在新建评测集…'); setErr(''); setMsg('')
    try {
      const csv = await readFileText(f)
      const j = await fetchJson<any>('/api/evalsets/create', { method: 'POST', headers: headers(), body: JSON.stringify({ id, name, csv, source: src }) })
      if (handle401(j)) { setBusy(''); return }
      setMsg(j.msg || (j.ok ? '创建成功' : '创建失败')); setBusy('')
      if (j.ok) { refreshEvalsets(); if (evalCsvRef.current) evalCsvRef.current.value = '' }
    } catch (e: any) { setErr('创建出错：' + (e.message || e)); setBusy('') }
  }, [headers, refreshEvalsets])

  const appendEval = useCallback(async () => {
    const f = appendCsvRef.current?.files?.[0]
    const id = (document.getElementById('appendId') as HTMLSelectElement)?.value
    if (!f) { setErr('请选择要追加的 CSV'); return }
    if (!id) { setErr('请选择要追加到的评测集'); return }
    setBusy('正在追加数据…'); setErr(''); setMsg('')
    try {
      const csv = await readFileText(f)
      const j = await fetchJson<any>('/api/evalsets/append', { method: 'POST', headers: headers(), body: JSON.stringify({ id, csv }) })
      if (handle401(j)) { setBusy(''); return }
      setMsg(j.msg || (j.ok ? '追加成功' : '追加失败')); setBusy('')
      if (j.ok) refreshEvalsets()
    } catch (e: any) { setErr('追加出错：' + (e.message || e)); setBusy('') }
  }, [headers, refreshEvalsets])

  const downloadEval = useCallback(async (id: string) => {
    try {
      const j = await fetchJson<any>('/api/evalsets/download?id=' + encodeURIComponent(id))
      if (j.ok && j.csv) {
        const blob = new Blob(['\uFEFF' + j.csv], { type: 'text/csv;charset=utf-8' })
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
        a.download = 'evalset_' + id + '.csv'; document.body.appendChild(a); a.click()
        document.body.removeChild(a); URL.revokeObjectURL(a.href)
      } else setErr(j.msg || '下载失败')
    } catch (e: any) { setErr('下载出错：' + (e.message || e)) }
  }, [])

  const loadLeaderboard = useCallback(async (id: string) => {
    if (!id) return
    setLbEval(id); setLb(null); setLbLoading(true); setErr('')
    try {
      const j = await fetchJson<any>('/api/evalsets/leaderboard?id=' + encodeURIComponent(id), undefined, 2, 1500)
      if (j.ok) setLb(j.rows || [])
      else setErr(j.msg || '排行榜获取失败')
    } catch (e: any) { setErr('排行榜出错：' + (e.message || e)) } finally { setLbLoading(false) }
  }, [])

  return (
    <div className="report-export" style={{ minHeight: '60vh' }}>
      <div className="report-head">
        <h3>🧪 模型工坊 / 评测中心</h3>
        <p className="report-sub">可插拔模型协议 · 统一封装 predict.py · 评测集排行榜</p>
      </div>

      {needToken && (
        <div className="report-empty">
          <p className="report-assume">🔐 服务器开启了上传保护，请填写上传口令（只保存在本浏览器，用于本次会话）：</p>
          <input
            type="password" value={token}
            onChange={(e) => { setToken(e.target.value); sessionStorage.setItem(TOKEN_KEY, e.target.value) }}
            placeholder="UPLOAD_TOKEN"
            style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--line-2)', background: 'var(--bg-3)', color: 'var(--txt)', width: 240 }}
          />
          <button className="btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => setNeedToken(false)}>保存并重试</button>
        </div>
      )}

      <div className="result-tabs" style={{ margin: '8px 0' }}>
        {([['models', '模型'], ['evalsets', '评测集'], ['leaderboard', '排行榜']] as [Tab, string][]).map(([k, label]) => (
          <button key={k} className={'result-tab' + (tab === k ? ' active' : '')} onClick={() => { setTab(k); if (k === 'leaderboard') refreshEvalsets() }}>
            <span className="result-tab-icon">{k === 'models' ? '📦' : k === 'evalsets' ? '📊' : '🏆'}</span>{label}
          </button>
        ))}
      </div>

      {msg && <div className="note" style={{ color: 'var(--mint)' }}>✅ {msg}</div>}
      {err && <div className="error">{err}</div>}
      {busy && <div className="report-running"><p>{busy}…</p><div className="report-progress"><div className="report-progress-fill" style={{ width: '60%' }} /></div></div>}

      {tab === 'models' && (
        <div className="report-body">
          <div className="report-section-title">已注册模型</div>
          <div className="report-table-wrap">
            <table className="report-table">
              <thead><tr><th>模型 id</th><th>名称</th><th>版本</th><th>类型</th></tr></thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.id}>
                    <td>{m.id}</td><td>{m.name}</td><td>{m.version || '-'}</td>
                    <td>{m.builtin ? '内置' : '导入'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="report-section-title">导入模型（zip）</div>
          <div className="protocol-box">
            <p className="report-note"><b>模型 = 一个 zip 压缩包</b>，里面必须包含两个文件（放在压缩包根目录）：</p>
            <pre className="protocol-code">{`模型包.zip
├── meta.json     # 报名表（必填）
└── predict.py    # 唯一入口（必填）`}</pre>
            <p className="report-note"><b>① meta.json（报名表）</b></p>
            <pre className="protocol-code">{`{
  "id": "my_model",   // 必填：模型唯一编号（字母/数字/下划线/短横线，≤48字符，与目录名一致）
  "name": "我的模型",  // 必填：显示名称
  "version": "1.0.0", // 建议
  "description": "……",
  "training": { "data": "训练数据说明" }
}`}</pre>
            <p className="report-note"><b>② predict.py（唯一入口）</b>：从 <code>stdin</code> 读 JSON、向 <code>stdout</code> 写 JSON——模型内部随便怎么算，最后每段给一个 <code>h2_kg</code>（kg/段）：</p>
            <pre className="protocol-code">{`输入（stdin）:
{"segments":[{"index":0,"distanceKm":10.0,"avgSpeedKmh":80,"gradePercent":0.5,
  "elevationM":1200,"temperatureC":25,"windSpeedKmh":10,"humidityPct":40,
  "roadLevel":"highway","durationH":0.125,"massKg":49000,"stopCount":0}, ...]}

输出（stdout）——每段必须一个 h2_kg:
{"segments":[{"index":0,"h2_kg":0.236}, ...]}`}</pre>
            <pre className="protocol-code">{`# 最小可用 predict.py（照这个改）:
import json, sys
def main():
    payload = json.loads(sys.stdin.read())
    out = []
    for i, s in enumerate(payload.get('segments', [])):
        dist = s.get('distanceKm', 1.0)
        out.append({'index': s.get('index', i), 'h2_kg': round(0.045 * dist, 4)})
    print(json.dumps({'segments': out}, ensure_ascii=False))
if __name__ == '__main__':
    main()`}</pre>
            <p className="report-note"><b>③ 导入</b>：把 <code>meta.json</code> + <code>predict.py</code> 打成 zip 上传。系统自动：校验 meta → 用内置仿真表<b>试工</b> → 每段输出合理才算成功；失败会回滚并告诉原因。📎 模板：仓库 <code>ml/model_templates/baseline_constant/</code>。</p>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input ref={modelZipRef} type="file" accept=".zip" />
            <button className="btn-primary" onClick={importModel} disabled={!!busy}>⬆ 导入并试工</button>
          </div>
        </div>
      )}

      {tab === 'evalsets' && (
        <div className="report-body">
          <div className="report-section-title">已有评测集</div>
          <div className="report-table-wrap">
            <table className="report-table">
              <thead><tr><th>id</th><th>名称</th><th>行数</th><th>来源</th><th></th></tr></thead>
              <tbody>
                {evalsets.map((e) => (
                  <tr key={e.id}>
                    <td>{e.id}</td><td>{e.name}</td><td>{e.n_rows}</td><td>{e.source || '-'}</td>
                    <td><button className="btn-cancel" style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => downloadEval(e.id)}>⬇ 下载</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="report-section-title">新建评测集</div>
          <div className="protocol-box">
            <p className="report-note"><b>评测集 = 一张 CSV 表格</b>，每行一条"段"记录，必须含以下列（缺一不可）：</p>
            <div className="report-table-wrap" style={{ margin: '6px 0' }}>
              <table className="report-table">
                <thead><tr><th>列名</th><th>含义</th><th>单位</th></tr></thead>
                <tbody>
                  {[['distanceKm','段里程','km'],['avgSpeedKmh','段均速','km/h'],['gradePercent','坡度','%（上坡+）'],['elevationM','海拔','m'],['temperatureC','温度','℃'],['windSpeedKmh','风速','km/h'],['humidityPct','湿度','%'],['roadLevel','道路等级','highway/national/provincial/expressway/city/county/other'],['durationH','段时长','h'],['massKg','总质量','kg'],['h2_kg','真实氢耗(ground truth)','kg/段']].map(([k,cn,u]) => (
                    <tr key={k}><td><code>{k}</code></td><td>{cn}</td><td>{u}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="report-note">可选列（缺省给默认）：<code>windDirDeg</code>、<code>windDirText</code>、<code>windAffects</code>、<code>gainM</code>、<code>stopCount</code>、<code>stopSecondsPer</code>、<code>vehicle</code>、<code>time</code>。</p>
            <pre className="protocol-code">{`# CSV 示例（表头 + 一行）:
distanceKm,avgSpeedKmh,gradePercent,elevationM,temperatureC,windSpeedKmh,humidityPct,roadLevel,durationH,massKg,h2_kg
1.333,80,0.5,1200,25,10,40,highway,0.016667,30000,0.065`}</pre>
            <p className="report-note"><b>流程</b>：新建（填 id/名称 + 上传 CSV，校验通过即建成）→ 追加（选评测集 + 上传 CSV）→ 排行榜（选评测集，全部模型跑一遍出排名）→ 下载（导出表格）。</p>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <input id="evalId" placeholder="评测集 id（字母数字下划线）" style={{ padding: 8, borderRadius: 8, border: '1px solid var(--line-2)', background: 'var(--bg-3)', color: 'var(--txt)' }} />
            <input id="evalName" placeholder="名称" style={{ padding: 8, borderRadius: 8, border: '1px solid var(--line-2)', background: 'var(--bg-3)', color: 'var(--txt)' }} />
            <input id="evalSrc" placeholder="来源说明（可选）" style={{ padding: 8, borderRadius: 8, border: '1px solid var(--line-2)', background: 'var(--bg-3)', color: 'var(--txt)' }} />
            <input ref={evalCsvRef} type="file" accept=".csv" />
            <button className="btn-primary" onClick={createEval} disabled={!!busy}>➕ 新建</button>
          </div>
          <div className="report-section-title">往已有评测集追加数据</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select id="appendId" style={{ padding: 8, borderRadius: 8, border: '1px solid var(--line-2)', background: 'var(--bg-3)', color: 'var(--txt)' }}>
              <option value="">选择评测集…</option>
              {evalsets.map((e) => <option key={e.id} value={e.id}>{e.id} · {e.name}</option>)}
            </select>
            <input ref={appendCsvRef} type="file" accept=".csv" />
            <button className="btn-primary" onClick={appendEval} disabled={!!busy}>➕ 追加</button>
          </div>
        </div>
      )}

      {tab === 'leaderboard' && (
        <div className="report-body">
          <div className="report-section-title">选择评测集</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={lbEval} onChange={(e) => loadLeaderboard(e.target.value)} style={{ padding: 8, borderRadius: 8, border: '1px solid var(--line-2)', background: 'var(--bg-3)', color: 'var(--txt)' }}>
              <option value="">选择评测集…</option>
              {evalsets.map((e) => <option key={e.id} value={e.id}>{e.id} · {e.name}（{e.n_rows}行）</option>)}
            </select>
            <button className="btn-primary" onClick={() => loadLeaderboard(lbEval)} disabled={!lbEval || lbLoading}>🏆 刷新排行榜</button>
          </div>
          {lbLoading && <p className="report-note">⏳ 首次评测约 3~4 分钟（内置 HistGB 全量工况合成），服务端已缓存 5 分钟，之后秒回。</p>}
          {lb && (
            <div className="report-table-wrap" style={{ marginTop: 12 }}>
              <table className="report-table">
                <thead><tr><th>排名</th><th>模型</th><th>类型</th><th>MAE (kg)</th><th>RMSE (kg)</th><th>R²</th><th>样本数</th></tr></thead>
                <tbody>
                  {lb.map((r) => r.error ? (
                    <tr key={r.model}><td>{r.rank ?? '-'}</td><td>{r.name}</td><td>{r.builtin ? '内置' : '导入'}</td><td colSpan={4} className="neg">❌ {r.error}</td></tr>
                  ) : (
                    <tr key={r.model} className={r.rank === 1 ? 'row-best' : ''}>
                      <td>{r.rank}{r.rank === 1 ? ' ⭐' : ''}</td><td>{r.name}</td><td>{r.builtin ? '内置' : '导入'}</td>
                      <td>{r.mae_kg}</td><td><b>{r.rmse_kg}</b></td><td>{r.r2}</td><td>{r.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="report-foot">按 RMSE 升序；每模型每评测集一条成绩。内置 HistGB/物理/常量基线自动陪跑。</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
