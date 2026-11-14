# -*- coding: utf-8 -*-
"""把 optimize_trial.json 渲染成可视化 HTML 报告（Pareto 前沿 + 路线对比 + 车速分布）"""
import json, io, os, sys

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(root, 'output', 'optimize_trial.json')
out = os.path.join(root, 'output', 'optimize_trial.html')
d = json.load(io.open(src, encoding='utf-8'))

pareto = d['pareto']
detail = d.get('detailAt100', [])
routes = d['routes']
colors = ['#3ae3ff', '#4d8dff', '#a473ff']

# ---- Pareto SVG ----
W, H, P = 720, 360, 60
times = [p['timeH'] for p in pareto]
costs = [p['cost'] for p in pareto]
minT, maxT = min(times), max(times)
minC, maxC = min(costs), max(costs)
if maxT == minT: maxT = minT + 0.01
if maxC == minC: maxC = minC + 1

def sx(t): return P + (t - minT) / (maxT - minT) * (W - 2 * P)
def sy(c): return H - P - (c - minC) / (maxC - minC) * (H - 2 * P)

points = ''.join(
    '<circle cx="%.1f" cy="%.1f" r="6" fill="%s" stroke="#fff" stroke-width="1.5"/>'
    % (sx(p['timeH']), sy(p['cost']), colors[p['route'] % 3]) for p in pareto
)
labels = ''.join(
    '<text x="%.1f" y="%.1f" fill="#9fb0d0" font-size="11" text-anchor="middle">λ=%d</text>'
    % (sx(p['timeH']), sy(p['cost']) - 12, p['lambda']) for p in pareto
)
grid = ''.join(
    '<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" stroke="rgba(255,255,255,.08)"/>'
    % (P, H - P - f * (H - 2 * P), W - P, H - P - f * (H - 2 * P)) for f in (0.25, 0.5, 0.75)
)
pareto_svg = (
    '<svg viewBox="0 0 %d %d" style="width:100%%;height:auto">%s'
    '<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="rgba(255,255,255,.25)"/>'
    '<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="rgba(255,255,255,.25)"/>'
    '%s%s'
    '<text x="%d" y="%d" fill="#9fb0d0" font-size="12" text-anchor="end">总时长 (h) →</text>'
    '<text x="12" y="20" fill="#9fb0d0" font-size="12">↑ 总费用 (元)</text>'
    '</svg>'
) % (W, H, grid, P, H - P, W - P, H - P, P, P, P, H - P, points, labels, W - P, H - 14)

# ---- 路线对比表 ----
def money(v): return '%.0f' % v
route_rows = ''
for r in sorted(detail, key=lambda x: x['cost']):
    c = routes[r['route']]['candidate']
    route_rows += (
        '<tr><td><b style="color:%s">路线 %d</b></td><td>%.1f</td><td>%.2f</td>'
        '<td>%.2f</td><td>%.2f</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td><b>%s</b></td></tr>'
    ) % (colors[r['route'] % 3], r['route'] + 1, c['distanceKm'], r['timeH'], r['h2Kg'],
         r['h2Kg'] / c['distanceKm'] * 100, money(r['h2Yuan']), money(r['toll']),
         money(r['driver']), money(r['other']), money(r['cost']))

# ---- 车速分布 ----
def dist(arr):
    m = {}
    for v in arr:
        m[v] = m.get(v, 0) + 1
    return sorted(m.items())

first, last = pareto[0], pareto[-1]
def bars(arr, title):
    bins = dist(arr)
    total = sum(n for _, n in bins) or 1
    rows = ''
    for v, n in bins:
        rows += '<div class="bar-row"><span class="bar-label">%d km/h</span><div class="bar-track"><i style="width:%.1f%%"></i></div><span class="bar-val">%d 段</span></div>' % (v, n / total * 100, n)
    return '<div class="card"><h3>%s</h3>%s</div>' % (title, rows)

html = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>偏好驱动的路线优化 · 试水版</title>
<style>
body{font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:#0a0f1e;color:#e8f0ff;margin:0;padding:24px}
.wrap{max-width:1100px;margin:0 auto}
h1{font-size:24px;background:linear-gradient(90deg,#3ae3ff,#4d8dff,#a473ff);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:#9fb0d0;font-size:13px;margin:6px 0 20px}
.card{background:#121a30;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:16px;margin-bottom:16px}
h2{font-size:17px;margin:0 0 12px}h3{font-size:14px;margin:0 0 10px;color:#9fb0d0}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:7px 9px;border-bottom:1px solid rgba(255,255,255,.08);text-align:left}
th{color:#9fb0d0;font-weight:600}
.legend span{margin-right:16px;font-size:12px;color:#9fb0d0}
svg{background:rgba(255,255,255,.02);border-radius:10px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.bar-row{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:12px}
.bar-label{width:56px;color:#9fb0d0}.bar-track{flex:1;height:10px;background:rgba(255,255,255,.08);border-radius:999px;overflow:hidden}
.bar-track i{display:block;height:100%;background:linear-gradient(90deg,#3ae3ff,#4d8dff);border-radius:999px}
.bar-val{width:52px;text-align:right;color:#9fb0d0}
.note{color:#ffb020;font-size:12px;line-height:1.8}
</style></head><body><div class="wrap">
<h1>偏好驱动的路线优化 · 试水版</h1>
<div class="sub">__ORIGIN__ → __DEST__ ｜ 氢耗用物理模型 ｜ 满载 49t ｜ Cd=0.27 ｜ 氢价 35 元/kg ｜ 司机 60 元/h ｜ 其他 0.5 元/km</div>

<div class="card"><h2>① Pareto 前沿：多花多少钱，能省多少时间</h2>
<div class="legend"><span style="color:#3ae3ff">● 路线 1</span><span style="color:#4d8dff">● 路线 2</span><span style="color:#a473ff">● 路线 3</span></div>
__PARETO_SVG__
</div>

<div class="card"><h2>② 各路线对比（λ=100 元/h）</h2>
<table><thead><tr><th>路线</th><th>里程 km</th><th>总时长 h</th><th>总氢耗 kg</th><th>百公里 kg/100km</th><th>氢费 元</th><th>过路费 元</th><th>司机费 元</th><th>其他 元</th><th>总费用 元</th></tr></thead>
<tbody>__ROUTE_ROWS__</tbody></table>
</div>

<div class="grid2">
__BARS_FIRST__
__BARS_LAST__
</div>

<div class="card"><h2>说明与边界</h2>
<p class="note">1) 氢耗用物理模型计算（段均速 + 坡度 + 海拔 + 附件），不含机器学习；<br>
2) 车速建议受"重卡限速 / 拥堵上限 / 坡度"约束，因此多数段建议车速会顶在上限；<br>
3) 物理模型中 49t 重卡滚动阻力占主导，氢耗对车速不太敏感，所以"经济车速"接近限速上限；<br>
4) 下一步：把速度并入 DP 做联合优化，并接入加氢/充电站可用性。</p>
</div>
</div></body></html>"""

html = (html
        .replace('__ORIGIN__', d['origin'])
        .replace('__DEST__', d['destination'])
        .replace('__PARETO_SVG__', pareto_svg)
        .replace('__ROUTE_ROWS__', route_rows)
        .replace('__BARS_FIRST__', bars(first['chosen'], '车速分布：λ=%d（最省钱）' % first['lambda']))
        .replace('__BARS_LAST__', bars(last['chosen'], '车速分布：λ=%d（最赶时间）' % last['lambda'])))

io.open(out, 'w', encoding='utf-8').write(html)
print('OK ->', out)
