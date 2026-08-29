# -*- coding: utf-8 -*-
"""Ridge 模型训练：Z(物理量12) + ACQ(可抓取12) + DEEP(深度9) → h2_per_km（5km 段级）
阶段二最终模型（非树、可解释），对应 docs/物理数据驱动融合模型_初步设计.md §3.5。
- 泄漏红线：h2_remain / 高压压力(与 h2_remain r=0.997) 不进特征
- 按行程分组 5 折 CV（防相邻 60s 泄漏）
- 保存 scaler+ridge 到 model_ridge.joblib + 元数据(含原始量纲系数，便于解释)
"""
import os
os.environ.setdefault('LOKY_MAX_CPU_COUNT', '1')
os.environ.setdefault('OMP_NUM_THREADS', '1')
import pandas as pd, numpy as np, io, sys, warnings, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
warnings.filterwarnings("ignore")
from collections import Counter, defaultdict
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.model_selection import GroupKFold
from sklearn.metrics import r2_score, mean_squared_error
import joblib
from feat import deep_feats, synth_segment, bucket_of, lv_ordinal, DEEP

HERE = os.path.dirname(os.path.abspath(__file__))

def load(p):
    raw = open(p, 'rb').read()
    for enc in ('utf-8-sig', 'gbk', 'gb18030'):
        try:
            return pd.read_csv(io.BytesIO(raw), encoding=enc)
        except Exception:
            continue
    raise RuntimeError('cannot decode ' + p)

df1, df2 = load(os.path.join(HERE, '..', '_v1_feat.csv')), load(os.path.join(HERE, '..', '_v2_feat.csv'))
df1['_car'] = 0; df2['_car'] = 1
df = pd.concat([df1, df2], ignore_index=True)
T = 'h2_consum_per_sec'

def num(name):
    cols = [c for c in df.columns if name in c]
    if not cols: raise KeyError(name)
    return pd.to_numeric(df[cols[0]], errors='coerce')

# ---------- Z：物理量（80 列 → 12 个有名有姓的物理量） ----------
v_kmh = num('canData_speed_车速') / 10.0
a = v_kmh.diff().fillna(0.0) / 3.6 / 60.0
fcA_c, fcB_c = num('celDataExt_fuelcell_output_cur_A'), num('celDataExt_fuelcell_output_cur_B')
fcA_v, fcB_v = num('celDataExt_fuelCell_output_vol_A'), num('celDataExt_fuelCell_output_vol_B')
I_FC = fcA_c + fcB_c
V_FC = (fcA_v + fcB_v) / 2.0
P_FC = fcA_c * fcA_v + fcB_c * fcB_v
mL_c, mR_c, mM_c = num('H49Data_back_bridge_motor_cur_L'), num('H49Data_back_bridge_motor_cur_R'), num('H49Data_mid_bridge_motor_cur')
mL_v, mR_v, mM_v = num('H49Data_back_bridge_motor_vol_L'), num('H49Data_back_bridge_motor_vol_R'), num('H49Data_mid_bridge_motor_vol')
P_mot = mL_c*mL_v + mR_c*mR_v + mM_c*mM_v
P_aux = (num('H49Data_acm_airpump_cur')*num('H49Data_acm_airpump_vol')
       + num('H49Data_edhv_fan_cur')*num('H49Data_edhv_fan_vol')
       + num('H49Data_ehps_fuelpump_cur')*num('H49Data_ehps_fuelpump_vol')
       + num('H49Data_wpump_cur_540v')*num('H49Data_wpump_vol_540v')
       + num('H49Data_air_compressor_power'))
P_batt = num('canData_battCur_总电流') * num('canData_battVol_总电压')
SOC = num('canData_battSoc_电池SOC')
T_stack = (num('celDataExt_volpile_output_temp_A') + num('celDataExt_volpile_output_temp_B')) / 2.0
T_bottle = pd.concat([num('celDataExt_h2_bottle_temp_%d' % i) for i in range(1, 7)], axis=1).mean(axis=1)
P_veh = P_mot + P_aux
Z = pd.DataFrame({
    'v_kmh': v_kmh, 'acc_mps2': a,
    'I_FC_A': I_FC, 'V_FC': V_FC, 'P_FC_kW': P_FC/1000.0,
    'P_mot_kW': P_mot/1000.0, 'P_aux_kW': P_aux/1000.0,
    'P_batt_kW': P_batt/1000.0, 'P_veh_kW': P_veh/1000.0,
    'SOC': SOC, 'T_stack_C': T_stack, 'T_bottle_C': T_bottle,
})

# ---------- 5km 段聚合 ----------
def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0; p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = np.radians(lat2-lat1); dl = np.radians(lon2-lon1)
    aa = np.sin(dp/2)**2 + np.cos(p1)*np.cos(p2)*np.sin(dl/2)**2
    return 2*R*np.arcsin(np.sqrt(aa))

y60 = num(T).fillna(0).values
lat = num('lat_纬度').values/1e6; lon = num('lon_经度').values/1e6
dist = np.zeros(len(df)); dist[1:] = haversine(lat[:-1], lon[:-1], lat[1:], lon[1:])
cum = np.cumsum(dist)
t = pd.to_datetime(df.iloc[:, 0], errors='coerce')
trip = (t.diff().dt.total_seconds().fillna(999) > 300).cumsum()
elev = num('elev_m').values
wpar = num('wind_par_kmh').fillna(0).values
grade = num('grade_pct').fillna(0).values
rows = []
for tr in np.unique(trip):
    idx = np.where(trip == tr)[0]
    c = cum[idx] - cum[idx][0]
    for sid in np.unique((c/5.0).astype(int)):
        s = idx[(c/5.0).astype(int) == sid]
        L = np.sum(dist[s])
        if L < 1.0: continue
        w = dist[s]/L
        es = elev[s]; gain = 0.0
        for _j in range(1, len(s)):
            if np.isfinite(es[_j]) and np.isfinite(es[_j-1]) and es[_j]-es[_j-1] > 0: gain += es[_j]-es[_j-1]
        row = {'trip': int(tr), 'car': int(df['_car'].iloc[s[0]]), 'len_km': L,
               'h2_per_km': float(np.sum(y60[s])/L), 'gain_m_per_km': float(gain/L),
               'hour': int(pd.Timestamp(t.values[s[0]]).hour), 'mass_kg': 30000.0,
               'lv': lv_ordinal(Counter(df['road_level'].iloc[s]).most_common(1)[0][0]),
               'v_mean': float(np.sum(w*v_kmh.values[s])), 'grade_mean': float(np.sum(w*grade[s])),
               'elev_mean': float(np.sum(w*elev[s])), 'temp_mean': float(np.sum(w*num('temp_c').values[s])),
               'wind_mean': float(np.sum(w*num('wind_kmh').values[s])), 'wind_par': float(np.sum(w*wpar[s])),
               'hum_mean': float(np.sum(w*num('hum_pct').values[s])),
               'v_series': v_kmh.values[s].tolist(), 'a_series': a.values[s].tolist(),
               'g_series': grade[s].tolist()}
        for k in Z.columns: row[k] = float(np.sum(w*Z[k].values[s]))
        rows.append(row)
seg = pd.DataFrame(rows)
seg = seg[(seg['h2_per_km'] > 0.02) & (seg['h2_per_km'] < 0.5)]

# DEEP：工况合成深度特征（固定随机种子，保证可复现）
rng = np.random.default_rng(42)
lib = defaultdict(list)
for _, r in seg.iterrows():
    b = bucket_of(r['lv'], r['v_mean']); lib[b].append(np.array(r['v_series'], float))
for i, r in seg.iterrows():
    vs, aa, gs = synth_segment(rng, r['v_mean'], r['grade_mean'], len(r['v_series']), lib, bucket_of(r['lv'], r['v_mean']))
    d = deep_feats(vs, aa, gs, r['len_km'])
    for k, v in d.items(): seg.at[i, k] = v

ZSEG = list(Z.columns)
ACQ_SEG = ['len_km','v_mean','grade_mean','gain_m_per_km','elev_mean','temp_mean','wind_mean','wind_par','hum_mean','hour','lv','mass_kg']
FEATURES = ZSEG + ACQ_SEG + DEEP
print('段数:', len(seg), '| 特征数:', len(FEATURES), '| 目标 h2_per_km 均值:', round(seg['h2_per_km'].mean(), 4))

X = seg[FEATURES].fillna(seg[FEATURES].median())
y = seg['h2_per_km']
groups = seg['trip'] + seg['car']*100000

# ---------- 按行程分组 5 折 CV ----------
pipe = Pipeline([('sc', StandardScaler()), ('ridge', Ridge(alpha=10.0))])
gkf = GroupKFold(5); r2s, rms = [], []
for tr, te in gkf.split(X, y, groups):
    m = Pipeline([('sc', StandardScaler()), ('ridge', Ridge(alpha=10.0))])
    m.fit(X.iloc[tr], y.iloc[tr]); p = m.predict(X.iloc[te])
    r2s.append(r2_score(y.iloc[te], p)); rms.append(np.sqrt(mean_squared_error(y.iloc[te], p)))
print('\n按行程分组 5 折 CV: R²=%.4f±%.4f  RMSE=%.4f kg/km' % (np.mean(r2s), np.std(r2s), np.mean(rms)))

# ---------- 全量训练并保存 ----------
pipe.fit(X, y)
joblib.dump(pipe, os.path.join(HERE, 'model_ridge.joblib'))

# 原始量纲系数（可解释）：coef_orig = coef_scaled / scale_
sc = pipe.named_steps['sc']; rg = pipe.named_steps['ridge']
coef_orig = dict(zip(FEATURES, (rg.coef_ / sc.scale_).tolist()))
coef_rank = sorted(coef_orig.items(), key=lambda kv: -abs(kv[1]))
print('\n=== 系数（每单位特征对 h2_per_km 的贡献，kg/km） Top10 ===')
for k, v in coef_rank[:10]:
    print(f'{v:+.5f}  {k}')

json.dump({
    'model': 'ridge', 'features': FEATURES, 'n_segments': int(len(seg)),
    'cv': {'r2_mean': round(float(np.mean(r2s)), 4), 'r2_std': round(float(np.std(r2s)), 4),
           'rmse_mean': round(float(np.mean(rms)), 4)},
    'alpha': 10.0, 'trained_at': '2026-08-29',
    'coef_per_unit': {k: round(v, 6) for k, v in coef_orig.items()},
}, open(os.path.join(HERE, 'ridge_meta.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('\n已保存: ml/model_ridge.joblib + ml/ridge_meta.json')
