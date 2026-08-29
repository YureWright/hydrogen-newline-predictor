# -*- coding: utf-8 -*-
"""混合管道：物理模型 → 仿真 Z → 校准(微调等价) → Ridge → 氢耗
对应 docs/物理数据驱动融合模型_初步设计.md §3.5.4 / §4。
- 真实 Z：训练段由 80 列实测算得（ml/train_ridge.py 同口径）
- 仿真 Z：同一训练段喂物理模型(ml/physics.py)，把中间量映射成 12 个 Z 物理量
- 校准（Ridge 不能像 NN 那样微调，等价做法=特征级仿射校准 Z_sim→Z_real）：
    对每个 Z 特征学 Z_real ≈ a·Z_sim + b（只在训练折内拟合，防泄漏）
- 评估（按行程分组 5 折 CV）：
    S1 Ridge(真实Z)           —— 上限（约 0.762）
    S2 Ridge(原始仿真Z)        —— 不校准会掉多少
    S3 Ridge(校准后仿真Z)      —— 校准(微调)能找回多少
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
import physics

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

# ---------- 真实 Z（按官方《数据计算方法》换算） ----------
v_kmh = num('canData_speed_车速') * 0.1                      # km/h
a = v_kmh.diff().fillna(0.0) / 3.6 / 60.0                     # m/s²
fcA_c, fcB_c = num('celDataExt_fuelcell_output_cur_A') * 0.1, num('celDataExt_fuelcell_output_cur_B') * 0.1
fcA_v, fcB_v = num('celDataExt_fuelCell_output_vol_A') * 0.1, num('celDataExt_fuelCell_output_vol_B') * 0.1
I_FC = fcA_c + fcB_c
V_FC = (fcA_v + fcB_v) / 2.0
P_FC = (fcA_c*fcA_v + fcB_c*fcB_v) / 1000.0                   # kW
mL_c, mR_c, mM_c = num('H49Data_back_bridge_motor_cur_L')-1000, num('H49Data_back_bridge_motor_cur_R')-1000, num('H49Data_mid_bridge_motor_cur')-1000
mL_v, mR_v, mM_v = num('H49Data_back_bridge_motor_vol_L')*0.1, num('H49Data_back_bridge_motor_vol_R')*0.1, num('H49Data_mid_bridge_motor_vol')*0.1
P_mot = (mL_c*mL_v + mR_c*mR_v + mM_c*mM_v) / 1000.0
P_aux = (num('H49Data_acm_airpump_cur')*0.1 * num('H49Data_acm_airpump_vol')*0.1
       + num('H49Data_edhv_fan_cur')*0.1 * num('H49Data_edhv_fan_vol')*0.1
       + num('H49Data_ehps_fuelpump_cur')*0.1 * num('H49Data_ehps_fuelpump_vol')*0.1
       + num('H49Data_wpump_cur_540v')*0.1 * num('H49Data_wpump_vol_540v')*0.1
       + num('H49Data_air_compressor_power')*0.1) / 1000.0
P_batt = (num('canData_battCur_总电流')*0.1 - 3000.0) * (num('canData_battVol_总电压')*0.1) / 1000.0
SOC = num('canData_battSoc_电池SOC')
T_stack = (num('celDataExt_volpile_output_temp_A') - 40.0 + num('celDataExt_volpile_output_temp_B') - 40.0) / 2.0
T_bottle = pd.concat([num('celDataExt_h2_bottle_temp_%d' % i) / 10.0 for i in range(1, 7)], axis=1).mean(axis=1)
P_veh = P_mot + P_aux
ZREAL = pd.DataFrame({
    'v_kmh': v_kmh, 'acc_mps2': a,
    'I_FC_A': I_FC, 'V_FC': V_FC, 'P_FC_kW': P_FC,
    'P_mot_kW': P_mot, 'P_aux_kW': P_aux,
    'P_batt_kW': P_batt, 'P_veh_kW': P_veh,
    'SOC': SOC, 'T_stack_C': T_stack, 'T_bottle_C': T_bottle,
})
ZCOLS = list(ZREAL.columns)

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
grade = num('grade_pct').fillna(0).values
temp = num('temp_c').values
wind = num('wind_kmh').fillna(0).values
rows = []
for tr in np.unique(trip):
    idx = np.where(trip == tr)[0]
    c = cum[idx] - cum[idx][0]
    for sid in np.unique((c/5.0).astype(int)):
        s = idx[(c/5.0).astype(int) == sid]
        L = np.sum(dist[s])
        if L < 1.0: continue
        w = dist[s]/L
        row = {'trip': int(tr), 'car': int(df['_car'].iloc[s[0]]), 'len_km': L,
               'h2_per_km': float(np.sum(y60[s])/L),
               'road_level': str(Counter(df['road_level'].iloc[s]).most_common(1)[0][0]),
               'v_mean': float(np.sum(w*v_kmh.values[s])), 'grade_mean': float(np.sum(w*grade[s])),
               'elev_mean': float(np.sum(w*elev[s])), 'temp_mean': float(np.sum(w*temp[s])),
               'wind_mean': float(np.sum(w*wind[s])),
               'v_series': v_kmh.values[s].tolist(), 'a_series': a.values[s].tolist(),
               'g_series': grade[s].tolist()}
        for k in ZCOLS: row[k] = float(np.sum(w*ZREAL[k].values[s]))
        rows.append(row)
seg = pd.DataFrame(rows)
seg = seg[(seg['h2_per_km'] > 0.02) & (seg['h2_per_km'] < 0.5)]
print('段数:', len(seg))

# ---------- 驱动循环物理仿真 → 仿真 Z（训练段用真实 v(t) 轨迹） ----------
import physics_cycle
ZSIM = pd.DataFrame(index=seg.index, columns=ZCOLS, dtype=float)
for i, r in seg.iterrows():
    z = physics_cycle.cycle_z(r['v_series'], r['g_series'], r['temp_mean'], mass_kg=30000.0)
    for k in ZCOLS:
        ZSIM.loc[i, k] = z[k]

print('\n===== 仿真Z(驱动循环) vs 真实Z 逐特征 Pearson r =====')
for k in ZCOLS:
    rr = np.corrcoef(seg[k], ZSIM[k])[0, 1]
    print(f'  {k:12s} r={rr:+.3f}')

# ---------- 校准(微调等价)：每个 Z 特征学 Z_real ≈ a·Z_sim + b ----------
def fit_calibration(Zr, Zs):
    ab = {}
    for k in ZCOLS:
        sv = Zs[k].values
        if np.nanstd(sv) < 1e-9:  # 仿真特征为常数（物理模型未建模该量）：用真实 Z 均值替代
            ab[k] = {'a': 0.0, 'b': float(np.mean(Zr[k].values))}
        else:
            a_, b_ = np.polyfit(sv, Zr[k].values, 1)
            ab[k] = {'a': float(a_), 'b': float(b_)}
    return ab

def apply_calibration(Zs, ab):
    out = Zs.copy()
    for k in ZCOLS:
        out[k] = Zs[k] * ab[k]['a'] + ab[k]['b']
    return out

# ---------- 评估（GroupKFold 防泄漏：校准只在该折训练部分拟合） ----------
y = seg['h2_per_km']; groups = seg['trip'] + seg['car']*100000
gkf = GroupKFold(5)
scen = {'S1_真实Z': [], 'S2_原始仿真Z': [], 'S3_校准仿真Z': [], 'S4_重训(仿真Z+真h2)': []}
def run_ridge(Xtr, ytr, Xte, yte):
    m = Pipeline([('sc', StandardScaler()), ('ridge', Ridge(alpha=10.0))])
    m.fit(Xtr, ytr); p = m.predict(Xte)
    return r2_score(yte, p), np.sqrt(mean_squared_error(yte, p))

for tr, te in gkf.split(ZSIM, y, groups):
    Xtr_r, Xte_r = seg.iloc[tr][ZCOLS], seg.iloc[te][ZCOLS]
    Xtr_s, Xte_s = ZSIM.iloc[tr], ZSIM.iloc[te]
    # 校准在训练折拟合，应用到测试折
    ab = fit_calibration(Xtr_r, Xtr_s)
    Xte_c = apply_calibration(Xte_s, ab)
    for name, Xte in [('S1_真实Z', Xte_r), ('S2_原始仿真Z', Xte_s), ('S3_校准仿真Z', Xte_c)]:
        r2, rm = run_ridge(Xtr_r, y.iloc[tr], Xte, y.iloc[te])
        scen[name].append((r2, rm))
    # S4：直接重训在仿真Z上（部署分布训练 = 线性模型的"微调"等价）
    r2, rm = run_ridge(Xtr_s, y.iloc[tr], Xte_s, y.iloc[te])
    scen['S4_重训(仿真Z+真h2)'].append((r2, rm))

print('\n===== 按行程分组 5 折 CV（目标 h2_per_km） =====')
for name, arr in scen.items():
    r2s = [x[0] for x in arr]; rms = [x[1] for x in arr]
    print(f'{name:16s}: R²={np.mean(r2s):+.3f}±{np.std(r2s):.3f}  RMSE={np.mean(rms):.4f} kg/km')

# ---------- 全量校准参数（上线用） ----------
ab_full = fit_calibration(seg[ZCOLS], ZSIM)
json.dump({'method': 'per-feature affine Z_sim->Z_real (Ridge 微调等价)',
           'sim': 'drive-cycle physics (physics_cycle.py, 真实v(t)轨迹)',
           'assumptions': '见 ml/physics_cycle.py CALIB（热模型/附件/母线450V）',
           'calib': ab_full,
           'fit_on': 'all training segments (real+sim Z)'},
          open(os.path.join(HERE, 'z_calibration.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('\n已保存: ml/z_calibration.json（上线时 仿真Z → 校准 → Ridge）')
