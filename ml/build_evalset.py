# -*- coding: utf-8 -*-
"""清洗两张车数据 → 标准评测集 CSV（供 eval_protocol.create 使用）

源：_v1_feat.csv / _v2_feat.csv（已含坡度/海拔/温度/风/湿度/道路等级）
映射：
  avgSpeedKmh = canData_speed × 0.1（原始值→km/h）
  distanceKm  = avgSpeedKmh × (60/3600)     # 60s 窗
  gradePercent= grade_pct, elevationM=elev_m, temperatureC=temp_c
  windSpeedKmh= wind_kmh, windDirDeg=wind_dir_deg, humidityPct=hum_pct
  roadLevel   = road_level（已是标准 key）
  durationH   = 1/60；massKg=30000（假设，文档注明）；gainM=0
  stopCount   = 0（无逐窗停车计数）；stopSecondsPer=30
  h2_kg       = h2_consum_per_sec（每 60s 窗氢耗，质量平衡差分）
  保留 vehicle / time
过滤：speed_kmh>=2（去掉停车窗）；h2_kg 有效且>0
"""
import csv, io, os, sys, glob
sys.stdout.reconfigure(encoding='utf-8')

SRC = {1: '_v1_feat.csv', 2: '_v2_feat.csv'}
OUT = os.path.join(os.environ.get('TEMP', '/tmp'), 'evalset_two_vehicles.csv')
COLS = ['distanceKm','avgSpeedKmh','gradePercent','elevationM','temperatureC',
        'windSpeedKmh','windDirDeg','windDirText','windAffects','humidityPct',
        'roadLevel','durationH','massKg','gainM','stopCount','stopSecondsPer',
        'vehicle','time','h2_kg']

# 列索引（_v1_feat/_v2_feat 同构）
IDX = {'time':0,'h2':3,'speed':33,'grade':81,'elev':80,'temp':82,'wind':83,
       'wind_dir':84,'hum':85,'road':91}

total = 0
with io.open(OUT, 'w', encoding='utf-8-sig', newline='') as fo:
    w = csv.writer(fo)
    w.writerow(COLS)
    for veh, fn in SRC.items():
        if not os.path.exists(fn):
            print('跳过（不存在）:', fn); continue
        n = 0; skipped = 0
        with open(fn, encoding='utf-8-sig') as f:
            r = csv.reader(f)
            header = next(r)
            for row in r:
                try:
                    speed_kmh = float(row[IDX['speed']]) * 0.1
                    h2 = float(row[IDX['h2']])
                except (ValueError, IndexError):
                    skipped += 1; continue
                if speed_kmh < 2 or h2 <= 0:
                    skipped += 1; continue
                dist = round(speed_kmh / 60.0, 5)
                wind_kmh = float(row[IDX['wind']] or 0)
                grade = float(row[IDX['grade']] or 0)
                elev = float(row[IDX['elev']] or 0)
                temp = float(row[IDX['temp']] or 20)
                hum = float(row[IDX['hum']] or 50)
                wd = row[IDX['wind_dir']] if len(row) > IDX['wind_dir'] and row[IDX['wind_dir']] not in ('', None) else ''
                w.writerow([
                    dist, round(speed_kmh,2), round(grade,3), round(elev,1), round(temp,1),
                    round(wind_kmh,1), wd if wd else '', '', 'true' if wind_kmh >= 10.8 else 'false',
                    round(hum,1), row[IDX['road']], round(1/60,6), 30000, 0, 0, 30,
                    'v%d' % veh, row[IDX['time']], round(h2,5),
                ])
                n += 1
        total += n
        print('车辆%d: 有效 %d 行（跳过 %d）' % (veh, n, skipped))
print('合计 %d 行 -> %s' % (total, OUT))
