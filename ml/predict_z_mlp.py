# -*- coding: utf-8 -*-
"""快速版：单网络多输出 MLP，用全部道路+天气特征同时预测 12 个 Z
按行程分组 5 折 CV（防相邻60s泄漏），每折只拟合 1 次（12 个输出一起学）。
"""
import os
os.environ.setdefault('LOKY_MAX_CPU_COUNT', '1')
os.environ.setdefault('OMP_NUM_THREADS', '1')
import pandas as pd, numpy as np, io, sys, warnings
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
warnings.filterwarnings("ignore")
from sklearn.neural_network import MLPRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.model_selection import GroupKFold
from sklearn.metrics import r2_score

def load(p):
    raw = open(p, 'rb').read()
    for enc in ('utf-8-sig', 'gbk', 'gb18030'):
        try: return pd.read_csv(io.BytesIO(raw), encoding=enc)
        except Exception: continue
df1, df2 = load('_v1_feat.csv'), load('_v2_feat.csv')
df1['_car'] = 0; df2['_car'] = 1
df = pd.concat([df1, df2], ignore_index=True)
def num(sub):
    c = [x for x in df.columns if sub in x]
    return pd.to_numeric(df[c[0]], errors='coerce') if c else None

v = num('canData_speed_车速') * 0.1
a = v.diff().fillna(0.0) / 3.6 / 60.0
fcAc, fcBc = num('celDataExt_fuelcell_output_cur_A')*0.1, num('celDataExt_fuelcell_output_cur_B')*0.1
fcAv, fcBv = num('celDataExt_fuelCell_output_vol_A')*0.1, num('celDataExt_fuelCell_output_vol_B')*0.1
I_FC = fcAc + fcBc; V_FC = (fcAv+fcBv)/2.0
P_FC = (fcAc*fcAv + fcBc*fcBv)/1000.0
mL_c, mR_c, mM_c = num('H49Data_back_bridge_motor_cur_L')-1000, num('H49Data_back_bridge_motor_cur_R')-1000, num('H49Data_mid_bridge_motor_cur')-1000
mL_v, mR_v, mM_v = num('H49Data_back_bridge_motor_vol_L')*0.1, num('H49Data_back_bridge_motor_vol_R')*0.1, num('H49Data_mid_bridge_motor_vol')*0.1
P_mot = (mL_c*mL_v + mR_c*mR_v + mM_c*mM_v)/1000.0
P_aux = (num('H49Data_acm_airpump_cur')*0.1*num('H49Data_acm_airpump_vol')*0.1
       + num('H49Data_edhv_fan_cur')*0.1*num('H49Data_edhv_fan_vol')*0.1
       + num('H49Data_ehps_fuelpump_cur')*0.1*num('H49Data_ehps_fuelpump_vol')*0.1
       + num('H49Data_wpump_cur_540v')*0.1*num('H49Data_wpump_vol_540v')*0.1
       + num('H49Data_air_compressor_power')*0.1)/1000.0
P_batt = (num('canData_battCur_总电流')*0.1-3000.0)*(num('canData_battVol_总电压')*0.1)/1000.0
SOC = num('canData_battSoc_电池SOC')
T_stack = (num('celDataExt_volpile_output_temp_A')-40+num('celDataExt_volpile_output_temp_B')-40)/2.0
T_bottle = pd.concat([num('celDataExt_h2_bottle_temp_%d'%i)/10.0 for i in range(1,7)],axis=1).mean(axis=1)
Z = pd.DataFrame({'v_kmh':v,'acc_mps2':a,'I_FC_A':I_FC,'V_FC':V_FC,'P_FC_kW':P_FC,
  'P_mot_kW':P_mot,'P_aux_kW':P_aux,'P_batt_kW':P_batt,'P_veh_kW':P_mot+P_aux,
  'SOC':SOC,'T_stack_C':T_stack,'T_bottle_C':T_bottle})

ACQ = pd.DataFrame({
  'v_kmh': v, 'acc_mps2': a, 'grade_pct': num('grade_pct'), 'elev_m': num('elev_m'),
  'temp_c': num('temp_c'), 'wind_kmh': num('wind_kmh'), 'wind_dir': num('wind_dir_deg'),
  'hum_pct': num('hum_pct'), 'precip': num('precip_mm'),
  'wind_par': num('wind_par_kmh'), 'wind_perp': num('wind_perp_kmh'),
})
t = pd.to_datetime(df.iloc[:, 0], errors='coerce')
ACQ['hour'] = t.dt.hour
trip = (t.diff().dt.total_seconds().fillna(999) > 300).cumsum()
groups = trip + df['_car'].values * 100000

X = ACQ.apply(pd.to_numeric, errors='coerce').fillna(ACQ.median())
fin = Z.notna().all(axis=1)
X, Y, g = X[fin], Z[fin], groups[fin]
print('样本数:', len(X), '| 特征:', len(X.columns), '| 输出: 12 个 Z')

model = Pipeline([('sc', StandardScaler()),
                  ('m', MLPRegressor(hidden_layer_sizes=(64,32), alpha=0.01,
                                     max_iter=400, early_stopping=True, random_state=42))])
gkf = GroupKFold(5)
pred = np.zeros_like(Y.values, dtype=float)
for tr, te in gkf.split(X, Y, g):
    m = Pipeline([('sc', StandardScaler()),
                  ('m', MLPRegressor(hidden_layer_sizes=(64,32), alpha=0.01,
                                     max_iter=400, early_stopping=True, random_state=42))])
    m.fit(X.iloc[tr], Y.iloc[tr]); pred[te] = m.predict(X.iloc[te])

print('\n===== 道路+天气 → 12个Z（单网络多输出，按行程分组5折CV） =====')
print('%-12s %10s %10s %10s' % ('Z', 'R²', 'RMSE', '可预测?'))
for j, k in enumerate(Z.columns):
    yt = Y.iloc[:, j].values
    r2 = r2_score(yt, pred[:, j])
    rm = float(np.sqrt(np.mean((yt-pred[:,j])**2)))
    tag = '✅' if r2 > 0.4 else ('⚠️' if r2 > 0.15 else '❌')
    print('%-12s %+10.3f %10.4f  %s' % (k, r2, rm, tag))
