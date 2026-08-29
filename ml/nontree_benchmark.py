# -*- coding: utf-8 -*-
"""非树模型对比实验：Z+ACQ+DEEP(全) → h2_per_km（5km 段级，按行程分组 CV）
回答：最终预测模型不用神经网络，非树模型里谁最好？
参考：HistGB(树基线) 与 MLP(神经网络，仅作参考，不入选)。
"""
import os
os.environ.setdefault('LOKY_MAX_CPU_COUNT', '1')
os.environ.setdefault('OMP_NUM_THREADS', '1')
import pandas as pd, numpy as np, io, sys, warnings, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
warnings.filterwarnings("ignore")
from collections import Counter, defaultdict
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge, Lasso, ElasticNet, BayesianRidge
from sklearn.svm import SVR
from sklearn.neighbors import KNeighborsRegressor
from sklearn.neural_network import MLPRegressor
from sklearn.preprocessing import StandardScaler, PolynomialFeatures
from sklearn.pipeline import Pipeline
from sklearn.model_selection import GroupKFold
from sklearn.metrics import r2_score, mean_squared_error
from feat import deep_feats, synth_segment, bucket_of, lv_ordinal, ACQUIRABLE, DEEP

def load(p):
    raw = open(p, 'rb').read()
    for enc in ('utf-8-sig', 'gbk', 'gb18030'):
        try: return pd.read_csv(io.BytesIO(raw), encoding=enc)
        except Exception: continue

df1, df2 = load('_v1_feat.csv'), load('_v2_feat.csv')
df1['_car'] = 0; df2['_car'] = 1
df = pd.concat([df1, df2], ignore_index=True)
T = 'h2_consum_per_sec'

def num(name):
    cols = [c for c in df.columns if name in c]
    if not cols: raise KeyError(name)
    return pd.to_numeric(df[cols[0]], errors='coerce')

v_kmh = num('canData_speed_车速') / 10.0
a = v_kmh.diff().fillna(0.0) / 3.6 / 60.0
fcA_c, fcB_c = num('celDataExt_fuelcell_output_cur_A'), num('celDataExt_fuelcell_output_cur_B')
fcA_v, fcB_v = num('celDataExt_fuelCell_output_vol_A'), num('celDataExt_fuelCell_output_vol_B')
P_FC = fcA_c*fcA_v + fcB_c*fcB_v
I_FC = fcA_c + fcB_c; V_FC = (fcA_v+fcB_v)/2.0
mL_c, mR_c, mM_c = num('H49Data_back_bridge_motor_cur_L'), num('H49Data_back_bridge_motor_cur_R'), num('H49Data_mid_bridge_motor_cur')
mL_v, mR_v, mM_v = num('H49Data_back_bridge_motor_vol_L'), num('H49Data_back_bridge_motor_vol_R'), num('H49Data_mid_bridge_motor_vol')
P_mot = mL_c*mL_v + mR_c*mR_v + mM_c*mM_v
P_aux = (num('H49Data_acm_airpump_cur')*num('H49Data_acm_airpump_vol')
       + num('H49Data_edhv_fan_cur')*num('H49Data_edhv_fan_vol')
       + num('H49Data_ehps_fuelpump_cur')*num('H49Data_ehps_fuelpump_vol')
       + num('H49Data_wpump_cur_540v')*num('H49Data_wpump_vol_540v')
       + num('H49Data_air_compressor_power'))
P_batt = num('canData_battCur_总电流')*num('canData_battVol_总电压')
SOC = num('canData_battSoc_电池SOC')
T_stack = (num('celDataExt_volpile_output_temp_A') + num('celDataExt_volpile_output_temp_B'))/2.0
T_bottle = pd.concat([num('celDataExt_h2_bottle_temp_%d' % i) for i in range(1,7)], axis=1).mean(axis=1)
P_veh = P_mot + P_aux
Z = pd.DataFrame({'v_kmh': v_kmh, 'acc_mps2': a, 'I_FC_A': I_FC, 'V_FC': V_FC,
    'P_FC_kW': P_FC/1000, 'P_mot_kW': P_mot/1000, 'P_aux_kW': P_aux/1000,
    'P_batt_kW': P_batt/1000, 'P_veh_kW': P_veh/1000, 'SOC': SOC,
    'T_stack_C': T_stack, 'T_bottle_C': T_bottle})

def haversine(lat1, lon1, lat2, lon2):
    R=6371.0; p1,p2=np.radians(lat1),np.radians(lat2)
    dp=np.radians(lat2-lat1); dl=np.radians(lon2-lon1)
    aa=np.sin(dp/2)**2+np.cos(p1)*np.cos(p2)*np.sin(dl/2)**2
    return 2*R*np.arcsin(np.sqrt(aa))

y60 = num(T).fillna(0).values
lat = num('lat_纬度').values/1e6; lon = num('lon_经度').values/1e6
dist = np.zeros(len(df)); dist[1:] = haversine(lat[:-1], lon[:-1], lat[1:], lon[1:])
cum = np.cumsum(dist)
t = pd.to_datetime(df.iloc[:,0], errors='coerce')
dt = t.diff().dt.total_seconds().fillna(999)
trip = (dt > 300).cumsum()
elev = num('elev_m').values
wpar = num('wind_par_kmh').fillna(0).values
grade = num('grade_pct').fillna(0).values
rows = []
for tr in np.unique(trip):
    idx = np.where(trip == tr)[0]
    c = cum[idx]-cum[idx][0]
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
X = seg[ZSEG + ACQ_SEG + DEEP].fillna(seg[ZSEG + ACQ_SEG + DEEP].median())
y = seg['h2_per_km']; g = seg['trip'] + seg['car']*100000
print('样本数:', len(seg), '| 特征数:', X.shape[1], '| 目标均值:', round(y.mean(),4), 'kg/km')

models = {
    'Ridge 岭回归': Pipeline([('sc', StandardScaler()), ('m', Ridge(alpha=10.0))]),
    'Lasso':        Pipeline([('sc', StandardScaler()), ('m', Lasso(alpha=0.005))]),
    'ElasticNet':   Pipeline([('sc', StandardScaler()), ('m', ElasticNet(alpha=0.005, l1_ratio=0.5))]),
    'BayesianRidge':Pipeline([('sc', StandardScaler()), ('m', BayesianRidge())]),
    'SVR(RBF)':     Pipeline([('sc', StandardScaler()), ('m', SVR(C=8.0, epsilon=0.005))]),
    'kNN(k=15)':    Pipeline([('sc', StandardScaler()), ('m', KNeighborsRegressor(n_neighbors=15, weights='distance'))]),
    '多项式2+Ridge': Pipeline([('sc', StandardScaler()), ('poly', PolynomialFeatures(degree=2, include_bias=False)), ('m', Ridge(alpha=50.0))]),
    'MLP 神经网络(参考,不入选)': Pipeline([('sc', StandardScaler()), ('m', MLPRegressor(hidden_layer_sizes=(32,16), alpha=0.01, max_iter=800, early_stopping=True, random_state=42))]),
    'HistGB 树基线(参考)': HistGradientBoostingRegressor(max_iter=350, learning_rate=0.05, max_depth=5, l2_regularization=1.0, random_state=42),
}
print('\n===== 按行程分组 5 折 CV（目标 h2_per_km, kg/km） =====')
results = []
for name, m in models.items():
    gkf = GroupKFold(5); r2s, rms = [], []
    for tr, te in gkf.split(X, y, g):
        mm = m; mm.fit(X.iloc[tr], y.iloc[tr]); p = mm.predict(X.iloc[te])
        r2s.append(r2_score(y.iloc[te], p)); rms.append(np.sqrt(mean_squared_error(y.iloc[te], p)))
    results.append((name, np.mean(r2s), np.std(r2s), np.mean(rms)))
    print(f'{name:22s}: R²={np.mean(r2s):+.3f}±{np.std(r2s):.3f}  RMSE={np.mean(rms):.4f} kg/km')

print('\n===== 非树模型排名（排除 NN/树） =====')
nontree = [r for r in results if 'MLP' not in r[0] and 'HistGB' not in r[0]]
nontree.sort(key=lambda r: -r[1])
for i, (name, r2, sd, rm) in enumerate(nontree, 1):
    print(f'#{i} {name}: R²={r2:+.3f}')
