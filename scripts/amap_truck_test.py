# -*- coding: utf-8 -*-
"""高德货车路径规划(v4/direction/truck) 测试脚本
用法:
  python scripts/amap_truck_test.py "lng,lat" "lng,lat"        # 默认 H49 重卡参数
  python scripts/amap_truck_test.py "116.326,39.997" "116.310,39.984"
读取 .env 里的 AMAP_KEY。若返回 INSUFFICIENT_PRIVILEGES，需先到高德开放平台
通过工单开通"货车路径规划服务(基础版)"（收费/试用）。
"""
import io, sys, os, json, urllib.request
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# ---- 读 key ----
key = ''
for line in io.open('.env', encoding='utf-8', errors='ignore'):
    line = line.strip()
    if line.startswith('AMAP_KEY='):
        key = line.split('=', 1)[1].strip().strip('"').strip("'")
if not key:
    print('❌ .env 里没有 AMAP_KEY，请先配置'); sys.exit(1)

origin = sys.argv[1] if len(sys.argv) > 1 else '116.326,39.997'
dest   = sys.argv[2] if len(sys.argv) > 2 else '116.310,39.984'

# ---- H49 氢能重卡参数（按需改）----
TRUCK = {
    'size': 4,        # 4=重型车(总质量>=12000kg)，H49 49吨级
    'load': 49,       # 车辆总重(吨)=核定载重+自重
    'weight': 30,     # 核定载重(吨)，按实际填
    'axis': 6,        # 轴数
    'height': 4.0,    # 车高(米)
    'width': 2.55,    # 车宽(米)
    'strategy': 11,   # 11=高德推荐(考虑路况)  10=无路况速度优先
    'showpolyline': 1,  # 返回 polyline（切分需要）
    'nosteps': 0,       # 返回 steps
}

params = '&'.join('%s=%s' % (k, v) for k, v in TRUCK.items())
url = 'https://restapi.amap.com/v4/direction/truck?key=%s&origin=%s&destination=%s&%s' % (key, origin, dest, params)
print('请求:', url.replace(key, '***KEY***'))
try:
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=25) as r:
        d = json.loads(r.read().decode('utf-8'))
except Exception as e:
    print('❌ 请求异常:', e); sys.exit(1)

if d.get('errcode') != 0:
    print('❌ 接口返回: errcode=%s errmsg=%s' % (d.get('errcode'), d.get('errmsg')))
    if 'INSUFFICIENT_PRIVILEGES' in str(d.get('errmsg')):
        print('   → 未开通货车路径规划服务。请到高德开放平台提交商务工单开通（可申请免费试用额度）。')
    sys.exit(1)

data = d.get('data', {})
paths = (data.get('route') or {}).get('paths', [])
print('✅ 调用成功！返回路线数:', data.get('count'), '| 限行状态 restriction:', (data.get('route') or {}).get('restriction', '见各 path'))
for i, p in enumerate(paths):
    dist_km = float(p.get('distance', 0)) / 1000
    dur_h = float(p.get('duration', 0)) / 3600
    avg = dist_km / dur_h if dur_h > 0 else 0
    print(f'\n--- 路线 #{i+1} ---')
    print(f'  距离={dist_km:.1f}km  时长={dur_h:.2f}h  均速={avg:.1f}km/h  收费={p.get("tolls")}元  限行={p.get("restriction")}')
    steps = p.get('steps') or []
    print('  分段数:', len(steps))
    for s in steps[:12]:
        sd = float(s.get('distance', 0)) / 1000
        ss = float(s.get('duration', 0))
        sv = sd / (ss/3600) if ss > 0 else 0
        print(f'    {sd:6.2f}km {sv:5.1f}km/h  {s.get("road","")}  | {s.get("instruction","")[:36]}')
