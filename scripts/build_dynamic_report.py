# -*- coding: utf-8 -*-
"""把 dynamic_plan.json 渲染成 HTML 报告（路线/车速/补能/动态重规划）"""
import json, io, os

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(root, 'output', 'dynamic_plan.json')
out = os.path.join(root, 'output', 'dynamic_plan.html')
d = json.load(io.open(src, encoding='utf-8'))

t = d['total']
replan = d.get('replan')
segs = d['speedPlan']

# ---- 车速曲线 SVG ----
W, H, P = 760, 260, 50
cum = []
s = 0
for x in segs:
    s += x['distanceKm']
    cum.append(s)
maxS = cum[-1] or 1
speeds = [x['speed'] for x in segs] or [0]
minV, maxV = min(speeds), max(speeds)
if maxV == minV: maxV = minV + 1
def sx(v): return P + v / maxS * (W - 2 * P)
def sy(v): return H - P - (v - minV) / (maxV - minV) * (H - 2 * P)
pts = ' '.join('%.1f,%.1f' % (sx(cum[i]), sy(segs[i]['speed'])) for i in range(len(segs)))
grid = ''.join('<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" stroke="rgba(255,255,255,.08)"/>'
               % (P, H - P - f * (H - 2 * P), W - P, H - P - f * (H - 2 * P)) for f in (0.33, 0.66))
speed_svg = ('<svg viewBox="0 0 %d %d" style="width:100%%;height:auto">%s'
             '<polyline points="%s" fill="none" stroke="#3ae3ff" stroke-width="2"/>'
             '<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="rgba(255,255,255,.25)"/>'
             '<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="rgba(255,255,255,.25)"/>'
             '<text x="%d" y="%d" fill="#9fb0d0" font-size="11" text-anchor="end">累计里程 km</text>'
             '<text x="8" y="18" fill="#9fb0d0" font-size="11">车速 km/h</text></svg>') % (
    W, H, grid, pts, P, H - P, W - P, H - P, P, P, P, H - P, W - P, H - 12)

# ---- 站点 ----
stations = d.get('stations', [])
st_rows = ''.join('<tr><td>%.0f</td><td>%s</td><td>%s</td><td>%.1f</td></tr>' % (
    x['s'], x['name'] or '—', ' / '.join({'h2': '加氢', 'elec': '充电'}.get(k, k) for k in x['types']), x['detourKm'])
    for x in stations[:40])

# ---- 补能计划 ----
stops = d.get('stops', [])
if stops:
    stop_rows = ''.join('<tr><td>%.0f</td><td>%s</td><td>%.1f kg</td><td>%.1f kWh</td><td>%.0f 元</td></tr>' % (
        x['s'], x['name'] or '—', x['h2Kg'], x['kWh'], x['cost']) for x in stops)
else:
    stop_rows = '<tr><td colspan="5" style="color:#3ddc84">全程无需补能（满氢 + 满电已覆盖）</td></tr>'

# ---- 动态重规划 ----
if replan:
    changed_rows = ''.join('<tr><td>%d</td><td>%s</td><td>%s</td><td>%d → %d</td></tr>' % (
        c['index'], c['roadName'] or '—', '%.1f km' % c['km'], c['oldSpeed'], c['newSpeed']) for c in replan['changed'])
    replan_html = """
<div class="card"><h2>④ 动态重规划演示</h2>
<p class="note">事件：行驶至 <b>%.0f km</b>（40%%）时，前方 50 km 突发<b>拥堵</b>，限速下降 30%%，系统用当前状态重算剩余行程。</p>
<table><thead><tr><th>指标</th><th>原方案</th><th>重规划后</th><th>变化</th></tr></thead><tbody>
<tr><td>总时长</td><td>%.2f h</td><td>%.2f h</td><td style="color:#ffb020">+%.1f 分钟</td></tr>
<tr><td>总氢耗</td><td>%.2f kg</td><td>%.2f kg</td><td>%+.2f kg</td></tr>
<tr><td>电耗</td><td>%.1f kWh</td><td>%.1f kWh</td><td>%+.1f kWh</td></tr>
</tbody></table>
<h3 style="margin-top:14px">受影响路段（%d 段，车速重新优化）</h3>
<table><thead><tr><th>段</th><th>道路</th><th>里程</th><th>建议车速</th></tr></thead><tbody>%s</tbody></table>
</div>""" % (
        replan['event']['atKm'], replan['before']['timeH'], replan['after']['timeH'], replan['delta']['timeMin'],
        replan['before']['h2Kg'], replan['after']['h2Kg'], replan['delta']['h2Kg'],
        replan['before']['energyKWh'], replan['after']['energyKWh'], replan['after']['energyKWh'] - replan['before']['energyKWh'],
        len(replan['changed']), changed_rows)
else:
    replan_html = ''

html = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>动态规划 · 试水版</title>
<style>
body{font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;background:#0a0f1e;color:#e8f0ff;margin:0;padding:24px}
.wrap{max-width:1100px;margin:0 auto}
h1{font-size:24px;background:linear-gradient(90deg,#3ae3ff,#4d8dff,#a473ff);-webkit-background-clip:text;background-clip:text;color:transparent;margin-bottom:6px}
.sub{color:#9fb0d0;font-size:13px;margin-bottom:18px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.kpi{background:#121a30;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:14px}
.kpi b{display:block;font-size:22px;color:#3ae3ff}.kpi span{font-size:12px;color:#9fb0d0}
.card{background:#121a30;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:16px;margin-bottom:16px}
h2{font-size:17px;margin:0 0 12px}h3{font-size:14px;color:#9fb0d0;margin:12px 0 8px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:7px 9px;border-bottom:1px solid rgba(255,255,255,.08);text-align:left}
th{color:#9fb0d0;font-weight:600}
.note{color:#ffb020;font-size:12.5px;line-height:1.8}
svg{background:rgba(255,255,255,.02);border-radius:10px}
</style></head><body><div class="wrap">
<h1>动态规划 · 路线 + 车速 + 氢电双补能</h1>
<div class="sub">__SUB__</div>

<div class="cards">
  <div class="kpi"><b>__KM__ km</b><span>总里程</span></div>
  <div class="kpi"><b>__TIME__ h</b><span>总时长（含充电）</span></div>
  <div class="kpi"><b>__COST__ 元</b><span>广义总成本（λ=__LAMBDA__ 元/h）</span></div>
  <div class="kpi"><b>__H2__ kg</b><span>氢耗（__H2_100__ kg/100km）</span></div>
  <div class="kpi"><b>__BAT__ kWh</b><span>电池用电</span></div>
  <div class="kpi"><b>__STOPS__ 次</b><span>补能次数</span></div>
</div>

<div class="card"><h2>① 车速规划（物理模型逐段经济车速）</h2>__SPEED_SVG__</div>

<div class="card"><h2>② 补能计划（氢 + 电双资源 DP）</h2>
<table><thead><tr><th>位置 km</th><th>站点</th><th>加氢</th><th>充电</th><th>花费</th></tr></thead><tbody>__STOP_ROWS__</tbody></table>
<p class="note">走廊内匹配到加氢站 __H2ST__ 座、充电站 __ELST__ 座（同位置 1km 内合并）。</p>
</div>

<div class="card"><h2>③ 路线走廊内的补能站（前 40 个）</h2>
<table><thead><tr><th>位置 km</th><th>站点</th><th>类型</th><th>绕行 km</th></tr></thead><tbody>__ST_ROWS__</tbody></table>
</div>

__REPLAN__

<div class="card"><h2>说明与边界</h2>
<p class="note">
1) 氢耗用物理模型，速度逐段扫描（30~90 km/h，受重卡限速/拥堵上限约束）；<br>
2) 双补能 DP 状态为（站点，剩余氢，SOC），按站价计费、含充电时间与绕行时间；<br>
3) 本路线 414km，满氢（50kg）+ 满电（124kWh）已覆盖，故无需中途补能；更长路线才会触发补能决策；<br>
4) 充电价格按 1.2 元/kWh、功率按 120kW 假设（高德 POI 无价格/功率）；<br>
5) 动态重规划目前是"事件重算"演示（40%% 处拥堵），生产版会按 5 分钟/事件滚动触发。
</p></div>
</div></body></html>"""

h2st = sum(1 for x in stations if 'h2' in x['types'])
elst = sum(1 for x in stations if 'elec' in x['types'])
html = (html
        .replace('__SUB__', '路线 %s → %s ｜ 物理模型 + 双补能 DP ｜ 满载 49t ｜ Cd=0.27' % ('起点', '终点'))
        .replace('__KM__', '%.1f' % t['km'])
        .replace('__TIME__', '%.2f' % (t['timeH'] + t.get('chargeH', 0)))
        .replace('__COST__', '%.0f' % t['planCost'])
        .replace('__LAMBDA__', str(d['lambda']))
        .replace('__H2__', '%.1f' % t['h2UsedKg'])
        .replace('__H2_100__', '%.2f' % (t['h2UsedKg'] / t['km'] * 100))
        .replace('__BAT__', '%.1f' % t['batUsedKWh'])
        .replace('__STOPS__', str(len(stops)))
        .replace('__SPEED_SVG__', speed_svg)
        .replace('__STOP_ROWS__', stop_rows)
        .replace('__H2ST__', str(h2st))
        .replace('__ELST__', str(elst))
        .replace('__ST_ROWS__', st_rows)
        .replace('__REPLAN__', replan_html))

io.open(out, 'w', encoding='utf-8').write(html)
print('OK ->', out)
