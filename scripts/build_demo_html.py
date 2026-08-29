# -*- coding: utf-8 -*-
"""从 demo/snapshot.json + demo/route-map.png 生成自包含离线演示 demo/demo.html
用法: python scripts/build_demo_html.py
"""
import json, base64, io, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEMO = os.path.join(ROOT, 'demo')
snap = json.load(io.open(os.path.join(DEMO, 'snapshot.json'), encoding='utf-8'))
mapb64 = base64.b64encode(open(os.path.join(DEMO, 'route-map.png'),'rb').read()).decode()

def compact_route(r):
    cand = {k: r['candidate'][k] for k in ['distanceKm','durationH','tollsYuan','tollDistanceKm','highwayRatio','avgSpeedKmh','topRoads']}
    cand['traffic'] = r['candidate'].get('traffic', {})
    segs = [{k: s.get(k) for k in ['index','roadName','roadLevel','distanceKm','avgSpeedKmh','gradePercent',
        'elevationM','temperatureC','windSpeedKmh','humidityPct','trafficStatus','motionBehavior','terrain','durationH']} for s in r['segments']]
    ml = {'total_h2_kg': r['ml'].get('total_h2_kg'), 'per100km_kg': r['ml'].get('per100km_kg'),
          'segments': [{k: s.get(k) for k in ['index','distanceKm','h2_kg','h2_per_km_kg']} for s in r['ml'].get('segments',[])]}
    ph = {'total_h2_kg': r['physics'].get('total_h2_kg'), 'per100km_kg': r['physics'].get('per100km_kg'),
          'segments': [{k: s.get(k) for k in ['index','distanceKm','h2_kg','h2_per_km_kg','P_fc','avgSpeedKmh']} for s in r['physics'].get('segments',[])]}
    return {'index': r['index'], 'candidate': cand, 'segments': segs, 'ml': ml, 'physics': ph, 'cost': r['cost'], 'summary': r['summary']}

data = {'meta': {'originName': snap['meta']['originName'], 'destinationName': snap['meta']['destinationName'],
                 'capturedAt': snap['meta']['capturedAt']},
        'routes': [compact_route(r) for r in snap['routes']],
        'ai': snap.get('ai'), 'aiError': snap.get('aiError') or ''}
js = 'const DATA = ' + json.dumps(data, ensure_ascii=False, separators=(',',':')).replace('</', '<\\/') + ';'
tpl = io.open(os.path.join(DEMO, 'template.html'), encoding='utf-8').read()
assert '/*__DATA__*/' in tpl and '__MAP__' in tpl
tpl = tpl.replace('/*__DATA__*/', js).replace('__MAP__', 'data:image/png;base64,' + mapb64)
out = os.path.join(DEMO, 'demo.html')
io.open(out, 'w', encoding='utf-8').write(tpl)
print('OK -> demo/demo.html %.1f KB' % (os.path.getsize(out)/1024))
