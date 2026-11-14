# -*- coding: utf-8 -*-
"""抓取全国充电站坐标（高德 POI 检索）

策略：行政区划接口拿 416 个城市 → 逐城按关键词「充电站」分页（每页 25，最多 8 页 = 200 条/城）
     → 按 POI id 去重 → 存 GeoJSON + CSV，支持断点续抓。

用法：
  python scripts/crawl_charging_stations.py                # 全量
  python scripts/crawl_charging_stations.py --cities 5     # 只测 5 个城市
  python scripts/crawl_charging_stations.py --max-pages 8  # 每城最多 8 页
"""
import argparse, csv, io, json, os, sys, time, urllib.parse, urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'data')
STATE = os.path.join(DATA, 'charging_crawl_state.json')
GEOJSON = os.path.join(DATA, 'charging_stations.geojson')
CSVOUT = os.path.join(DATA, 'charging_stations.csv')

def load_key():
    for line in io.open(os.path.join(ROOT, '.env'), encoding='utf-8', errors='ignore'):
        if line.startswith('AMAP_KEY='):
            return line.split('=', 1)[1].strip().strip('"').strip("'")
    raise RuntimeError('缺少 AMAP_KEY')

KEY = load_key()

def call(path, **params):
    params['key'] = KEY
    url = 'https://restapi.amap.com/v3/' + path + '?' + urllib.parse.urlencode(params)
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=20) as r:
                d = json.loads(r.read().decode('utf-8'))
            # QPS 限流：退避后重试
            if d.get('status') != '1' and d.get('infocode') == '10021':
                time.sleep(3 + attempt * 2)
                continue
            return d
        except Exception as e:
            if attempt == 4:
                return {'status': '0', 'info': 'EXC %s' % e}
            time.sleep(1.5)
    return {'status': '0', 'info': 'QPS_RETRY_EXHAUSTED', 'infocode': '10021'}

def get_cities():
    d = call('config/district', keywords='中国', subdistrict=2, extensions='base')
    if d.get('status') != '1':
        raise RuntimeError('行政区划接口失败: %s' % d.get('info'))
    cities = []
    for prov in (d.get('districts') or [{}])[0].get('districts') or []:
        for c in prov.get('districts') or []:
            if c.get('adcode'):
                cities.append({'name': c.get('name'), 'adcode': c.get('adcode'), 'province': prov.get('name')})
    return cities

def load_state():
    if os.path.exists(STATE):
        return json.load(io.open(STATE, encoding='utf-8'))
    return {'done': {}, 'pois': {}}

def save_state(st):
    tmp = STATE + '.tmp'
    io.open(tmp, 'w', encoding='utf-8').write(json.dumps(st, ensure_ascii=False))
    os.replace(tmp, STATE)

def save_outputs(st):
    feats = []
    for pid, p in st['pois'].items():
        lng, lat = p['lng'], p['lat']
        feats.append({
            'type': 'Feature',
            'geometry': {'type': 'Point', 'coordinates': [lng, lat]},
            'properties': {k: p.get(k) for k in ['id', 'name', 'address', 'adname', 'cityname', 'pname', 'typecode', 'type', 'tel']},
        })
    io.open(GEOJSON, 'w', encoding='utf-8').write(json.dumps({'type': 'FeatureCollection', 'features': feats}, ensure_ascii=False))
    with io.open(CSVOUT, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow(['id', 'name', 'lng', 'lat', 'address', 'adname', 'cityname', 'pname', 'type'])
        for p in st['pois'].values():
            w.writerow([p.get('id'), p.get('name'), p.get('lng'), p.get('lat'), p.get('address'),
                        p.get('adname'), p.get('cityname'), p.get('pname'), p.get('type')])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cities', type=int, default=0, help='只抓前 N 个城市（0=全部）')
    ap.add_argument('--max-pages', type=int, default=8)
    ap.add_argument('--sleep', type=float, default=0.15)
    ap.add_argument('--retry-empty', action='store_true', help='重抓上次拿到 0 条的城市')
    args = ap.parse_args()

    os.makedirs(DATA, exist_ok=True)
    st = load_state()
    cities = get_cities()
    if args.cities:
        cities = cities[:args.cities]
    if args.retry_empty:
        todo = [c for c in cities if c['adcode'] not in st['done'] or st['done'][c['adcode']].get('got', 0) == 0]
    else:
        todo = [c for c in cities if c['adcode'] not in st['done']]
    print('城市总数 %d，已完成 %d，待抓取 %d' % (len(cities), len(cities) - len(todo), len(todo)))

    calls = 0
    t0 = time.time()
    for idx, city in enumerate(todo, 1):
        capped = False
        got = 0
        for page in range(1, args.max_pages + 1):
            d = call('place/text', keywords='充电站', city=city['adcode'], citylimit='true',
                     offset=25, page=page, extensions='base')
            calls += 1
            if d.get('status') != '1':
                info = d.get('info') or ''
                code = d.get('infocode')
                print('  城市 %s 查询失败: %s (%s)' % (city['name'], info, code))
                if code in ('10003', '10044', '10045', '10019', '10020'):
                    print('  ⚠ 疑似配额用尽，保存进度后退出')
                    save_state(st); save_outputs(st)
                    return
                break
            pois = d.get('pois') or []
            if not pois:
                break
            for p in pois:
                loc = (p.get('location') or '').split(',')
                if len(loc) != 2:
                    continue
                pid = p.get('id')
                if not pid:
                    continue
                st['pois'][pid] = {
                    'id': pid, 'name': p.get('name'), 'lng': float(loc[0]), 'lat': float(loc[1]),
                    'address': p.get('address'), 'adname': p.get('adname'), 'cityname': p.get('cityname'),
                    'pname': p.get('pname'), 'typecode': p.get('typecode'), 'type': p.get('type'), 'tel': p.get('tel'),
                }
                got += 1
            if len(pois) < 25:
                break
            if page == args.max_pages:
                capped = True
            time.sleep(args.sleep)
        st['done'][city['adcode']] = {'name': city['name'], 'province': city['province'], 'got': got, 'capped': capped}
        if idx % 5 == 0 or idx == len(todo):
            save_state(st); save_outputs(st)
            elapsed = time.time() - t0
            print('[%d/%d] %s %s: +%d（累计 %d 座，调用 %d 次，%.0fs）' % (
                idx, len(todo), city['province'], city['name'], got, len(st['pois']), calls, elapsed))
    save_state(st); save_outputs(st)
    print('\n完成：%d 座充电站，调用 %d 次，耗时 %.0fs' % (len(st['pois']), calls, time.time() - t0))
    print('输出:', GEOJSON, '|', CSVOUT)

if __name__ == '__main__':
    main()
