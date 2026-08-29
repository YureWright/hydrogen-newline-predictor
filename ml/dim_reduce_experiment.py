# -*- coding: utf-8 -*-
"""降维方案验证实验：80列 → 13~15 物理量 Z → 氢耗
对应 docs/物理数据驱动融合模型_初步设计.md §3.5。
数据：_v1_feat.csv / _v2_feat.csv（80 内部列 + 回填路线特征）。
① 60s 级：Z / ACQ(路线可抓取) / Z+ACQ / 原始75列(Ridge) → h2_consum_per_sec
② 5km 段级：与现有 HistGB 基线同口径，对比 Z / Z+ACQ / Z+ACQ+DEEP
泄漏红线：h2_remain、高压压力(与h2_remain r=0.997) 不进特征。
"""
import os
os.environ.setdefault('LOKY_MAX_CPU_COUNT', '1')
os.environ.setdefault('OMP_NUM_THREADS', '1')
import pandas as pd, numpy as np, io, sys, warnings, math, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
warnings.filterwarnings("ignore")
from collections import Counter, defaultdict
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.model_selection import GroupKFold
from sklearn.metrics import r2_score, mean_squared_error
from feat import deep_feats, synth_segment, bucket_of, lv_ordinal, ACQUIRABLE, DEEP

def load(p):
    raw = open(p, 'rb').read()
    for enc in ('utf-8-sig', 'gbk', 'gb18030'):
        try:
            return pd.read_csv(io.BytesIO(raw), encoding=enc)
        except Exception:
            continue
    raise RuntimeError('cannot decode ' + p)

df1, df2 = load('_v1_feat.csv'), load('_v2_feat.csv')
df1['_car'] = 0; df2['_car'] = 1
df = pd.concat([df1, df2], ignore_index=True)
T = 'h2_consum_per_sec'
print('总行数:', len(df))

def num(name):
    cols = [c for c in df.columns if name in c]
    if not cols: raise KeyError(name)
    return pd.to_numeric(df[cols[0]], errors='coerce')

# ---------- 构建 Z（60s 级） ----------
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
ACQ60 = pd.DataFrame({
    'v_kmh': v_kmh, 'grade_pct': num('grade_pct'), 'elev_m': num('elev_m'),
    'temp_c': num('temp_c'), 'wind_kmh': num('wind_kmh'), 'hum_pct': num('hum_pct'),
    'lv': pd.to_numeric(df['road_level'], errors='coerce').map(lambda x: lv_ordinal(x) if not pd.isna(x) else 6),
})
y60 = num(T)
t = pd.to_datetime(df.iloc[:, 0], errors='coerce')
dt = t.diff().dt.total_seconds().fillna(999)
trip = (dt > 300).cumsum()
groups = trip + df['_car'] * 100000
mask = y60.notna() & v_kmh.notna()

def hgb():
    return HistGradientBoostingRegressor(max_iter=350, learning_rate=0.05, max_depth=5,
                                         l2_regularization=1.0, random_state=42)

def cv_report(X, y, groups, model_factory, name):
    gkf = GroupKFold(5); r2s, rms = [], []
    for tr, te in gkf.split(X, y, groups):
        m = model_factory(); m.fit(X.iloc[tr], y.iloc[tr])
        p = m.predict(X.iloc[te])
        r2s.append(r2_score(y.iloc[te], p)); rms.append(np.sqrt(mean_squared_error(y.iloc[te], p)))
    print(f'{name}: R²={np.mean(r2s):+.3f}±{np.std(r2s):.3f}  RMSE={np.mean(rms):.4f} kg/60s')
    return np.mean(r2s)

print('\n===== ① 60s 级：按行程分组 5 折 CV（目标 h2_consum_per_sec, kg/60s） =====')
Xz = Z[mask].fillna(Z[mask].median()); Xa = ACQ60[mask].fillna(ACQ60[mask].median())
Xza = pd.concat([Xz, Xa.drop(columns=['v_kmh'])], axis=1)
y = y60[mask]; g = groups[mask]
cv_report(Xz, y, g, hgb, 'Z 物理量(12)        ')
cv_report(Xa, y, g, hgb, 'ACQ 路线可抓取(6)    ')
cv_report(Xza, y, g, hgb, 'Z + ACQ(17)          ')
raw = df.drop(columns=[df.columns[0], 'VIN', 'lat_纬度', 'lon_经度', T, 'celDataExt_h2_remain_氢气剩余量', 'celDataExt_high_pressure_高压压力(气瓶平均压力)', '_car'])
raw = raw.apply(pd.to_numeric, errors='coerce')
raw = raw.drop(columns=[c for c in raw.columns if raw[c].nunique(dropna=True) <= 1])
raw = raw[mask].fillna(raw[mask].median())
cv_report(raw, y, g, lambda: Ridge(alpha=100.0), '原始75列 Ridge      ')

print('\n===== Z 各变量与目标相关性（60s 级） =====')
corr = pd.concat([Xz, y], axis=1).corr()[T].drop(T).sort_values(key=np.abs, ascending=False)
for k, v in corr.items():
    print(f'{abs(v):.3f}  {v:+.3f}  {k}')

# ---------- ② 5km 段级聚合 ----------
print('\n===== ② 5km 段级：与现有 HistGB 基线同口径（目标 h2_per_km, kg/km） =====')
def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0; p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = np.radians(lat2-lat1); dl = np.radians(lon2-lon1)
    a = np.sin(dp/2)**2 + np.cos(p1)*np.cos(p2)*np.sin(dl/2)**2
    return 2*R*np.arcsin(np.sqrt(a))

lat = num('lat_纬度').values/1e6; lon = num('lon_经度').values/1e6
dist = np.zeros(len(df)); dist[1:] = haversine(lat[:-1], lon[:-1], lat[1:], lon[1:])
cum = np.cumsum(dist)
h2 = y60.fillna(0).values
elev = num('elev_m').values
wpar = num('wind_par_kmh').fillna(0).values
tm = t.values
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
            if np.isfinite(es[_j]) and np.isfinite(es[_j-1]) and es[_j]-es[_j-1] > 0:
                gain += es[_j]-es[_j-1]
        row = {'trip': int(tr), 'car': int(df['_car'].iloc[s[0]]), 'len_km': L,
               'h2_per_km': float(np.sum(h2[s])/L),
               'gain_m_per_km': float(gain/L),
               'hour': int(pd.Timestamp(tm[s[0]]).hour),
               'mass_kg': 30000.0,
               'lv': lv_ordinal(Counter(df['road_level'].iloc[s]).most_common(1)[0][0]),
               'v_mean': float(np.sum(w*v_kmh.values[s])), 'grade_mean': float(np.sum(w*num('grade_pct').values[s])),
               'elev_mean': float(np.sum(w*elev[s])), 'temp_mean': float(np.sum(w*num('temp_c').values[s])),
               'wind_mean': float(np.sum(w*num('wind_kmh').values[s])), 'wind_par': float(np.sum(w*wpar[s])),
               'hum_mean': float(np.sum(w*num('hum_pct').values[s])),
               'v_series': v_kmh.values[s].tolist(), 'a_series': a.values[s].tolist(),
               'g_series': num('grade_pct').fillna(0).values[s].tolist()}
        for k in Z.columns:
            row[k] = float(np.sum(w*Z[k].values[s]))
        rows.append(row)
seg = pd.DataFrame(rows)
seg = seg[(seg['h2_per_km'] > 0.02) & (seg['h2_per_km'] < 0.5)]
print('段数:', len(seg), '| 目标分布:', seg['h2_per_km'].describe()[['mean','50%','min','max']].round(4).to_dict())

rng = np.random.default_rng(42)
lib = defaultdict(list)
for _, r in seg.iterrows():
    b = bucket_of(r['lv'], r['v_mean']); lib[b].append(np.array(r['v_series'], float))
for i, r in seg.iterrows():
    vs, aa, gs = synth_segment(rng, r['v_mean'], r['grade_mean'], len(r['v_series']), lib, bucket_of(r['lv'], r['v_mean']))
    d = deep_feats(vs, aa, gs, r['len_km'])
    for k, v in d.items(): seg.at[i, k] = v

ZSEG = list(Z.columns)
ACQ_SEG = [c for c in ['len_km','v_mean','grade_mean','gain_m_per_km','elev_mean','temp_mean','wind_mean','wind_par','hum_mean','hour','lv','mass_kg']]
gseg = seg['trip'] + seg['car']*100000
yset = seg['h2_per_km']
def cvseg(X, name):
    X = X.fillna(X.median()); gkf = GroupKFold(5); r2s, rms = [], []
    for tr, te in gkf.split(X, yset, gseg):
        m = hgb(); m.fit(X.iloc[tr], yset.iloc[tr]); p = m.predict(X.iloc[te])
        r2s.append(r2_score(yset.iloc[te], p)); rms.append(np.sqrt(mean_squared_error(yset.iloc[te], p)))
    print(f'{name}: R²={np.mean(r2s):+.3f}±{np.std(r2s):.3f}  RMSE={np.mean(rms):.4f} kg/km')
    return np.mean(r2s)
cvseg(seg[ACQUIRABLE + DEEP], '基线 ACQ+DEEP(现有) ')
cvseg(seg[ZSEG], 'Z 物理量(12)        ')
cvseg(seg[ZSEG + ACQ_SEG], 'Z + ACQ              ')
cvseg(seg[ZSEG + ACQ_SEG + DEEP], 'Z + ACQ + DEEP(全)   ')

print('\n===== 特征重要性（60s 级 Z+ACQ 模型，置换重要性） =====')
from sklearn.inspection import permutation_importance
m = hgb(); m.fit(Xza, y)
pi = permutation_importance(m, Xza, y, n_repeats=3, random_state=42, scoring='r2')
imp = sorted(zip(Xza.columns, pi.importances_mean), key=lambda x: -x[1])
for k, v in imp[:17]:
    print(f'{v:.3f}  {k}')
