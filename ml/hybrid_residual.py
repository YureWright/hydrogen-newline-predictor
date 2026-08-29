# -*- coding: utf-8 -*-
"""物理模型 + 残差学习（口味A）：h2_pred = h2_physics + ML(路线特征→残差)
- 物理模型：ml/physics.py 按段算氢耗（h2_per_km_kg）
- 残差：residual = h2_real - h2_physics
- ML：HistGB / Ridge 用 ACQ(+DEEP) 特征学残差
- 按行程分组 5 折 CV，对比：物理单独 / ML单独(现有基线) / 物理+残差ML
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
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.model_selection import GroupKFold
from sklearn.metrics import r2_score, mean_squared_error
from feat import deep_feats, synth_segment, bucket_of, lv_ordinal, ACQUIRABLE, DEEP
import physics

HERE = os.path.dirname(os.path.abspath(__file__))
def load(p):
    raw = open(p, 'rb').read()
    for enc in ('utf-8-sig', 'gbk', 'gb18030'):
        try: return pd.read_csv(io.BytesIO(raw), encoding=enc)
        except Exception: continue
df1, df2 = load(os.path.join(HERE,'..','_v1_feat.csv')), load(os.path.join(HERE,'..','_v2_feat.csv'))
df1['_car']=0; df2['_car']=1
df = pd.concat([df1, df2], ignore_index=True)
def num(sub):
    c=[x for x in df.columns if sub in x]; return pd.to_numeric(df[c[0]], errors='coerce') if c else None
T='h2_consum_per_sec'

v = num('canData_speed_车速')*0.1
a = v.diff().fillna(0.0)/3.6/60.0
def hav(lat1,lon1,lat2,lon2):
    R=6371.0;p1,p2=np.radians(lat1),np.radians(lat2);dp=np.radians(lat2-lat1);dl=np.radians(lon2-lon1)
    aa=np.sin(dp/2)**2+np.cos(p1)*np.cos(p2)*np.sin(dl/2)**2;return 2*R*np.arcsin(np.sqrt(aa))
lat=num('lat_纬度').values/1e6;lon=num('lon_经度').values/1e6
dist=np.zeros(len(df));dist[1:]=hav(lat[:-1],lon[:-1],lat[1:],lon[1:]);cum=np.cumsum(dist)
t=pd.to_datetime(df.iloc[:,0],errors='coerce');trip=(t.diff().dt.total_seconds().fillna(999)>300).cumsum()
y60=num(T).fillna(0).values
elev=num('elev_m').values;grade=num('grade_pct').fillna(0).values
temp=num('temp_c').values;wind=num('wind_kmh').fillna(0).values
wpar=num('wind_par_kmh').fillna(0).values
rows=[]
for tr in np.unique(trip):
    idx=np.where(trip==tr)[0];c=cum[idx]-cum[idx][0]
    for sid in np.unique((c/5.0).astype(int)):
        s=idx[(c/5.0).astype(int)==sid];L=np.sum(dist[s])
        if L<1.0:continue
        w=dist[s]/L;es=elev[s];gain=0.0
        for _j in range(1,len(s)):
            if np.isfinite(es[_j]) and np.isfinite(es[_j-1]) and es[_j]-es[_j-1]>0: gain+=es[_j]-es[_j-1]
        rows.append({'trip':int(tr),'car':int(df['_car'].iloc[s[0]]),'len_km':L,
            'h2_per_km':float(np.sum(y60[s])/L),'gain_m_per_km':float(gain/L),
            'hour':int(pd.Timestamp(t.values[s[0]]).hour),'mass_kg':30000.0,
            'lv':lv_ordinal(Counter(df['road_level'].iloc[s]).most_common(1)[0][0]),
            'v_mean':float(np.sum(w*v.values[s])),'grade_mean':float(np.sum(w*grade[s])),
            'elev_mean':float(np.sum(w*elev[s])),'temp_mean':float(np.sum(w*temp[s])),
            'wind_mean':float(np.sum(w*wind[s])),'wind_par':float(np.sum(w*wpar[s])),
            'hum_mean':float(np.sum(w*num('hum_pct').values[s])),
            'v_series':v.values[s].tolist(),'a_series':a.values[s].tolist(),
            'g_series':grade[s].tolist()})
seg=pd.DataFrame(rows)
seg=seg[(seg['h2_per_km']>0.02)&(seg['h2_per_km']<0.5)]
print('段数:',len(seg))

# ---- 物理模型氢耗 ----
def phys_h2(r):
    p=physics.predict_segment({'distanceKm':r['len_km'],'avgSpeedKmh':r['v_mean'],
        'gradePercent':float(r['grade_mean']) if pd.notna(r['grade_mean']) else None,
        'elevationM':r['elev_mean'],'temperatureC':r['temp_mean'],'massKg':30000.0,
        'windSpeedKmh':r['wind_mean'],'windAffects':False,'roadLevel':'other'})
    return float(p.get('h2_per_km_kg') or p.get('m_H2',0)/max(r['len_km'],1e-6))
seg['h2_phys']=seg.apply(phys_h2,axis=1)
seg['resid']=seg['h2_per_km']-seg['h2_phys']
print('物理氢耗分布:',seg['h2_phys'].describe()[['mean','50%']].round(4).to_dict())
print('残差分布: 中位 %.4f, 均值 %.4f kg/km'%(seg['resid'].median(),seg['resid'].mean()))

# ---- DEEP 特征 ----
rng=np.random.default_rng(42)
lib=defaultdict(list)
for _,r in seg.iterrows():
    b=bucket_of(r['lv'],r['v_mean']);lib[b].append(np.array(r['v_series'],float))
for i,r in seg.iterrows():
    vs,aa,gs=synth_segment(rng,r['v_mean'],r['grade_mean'],len(r['v_series']),lib,bucket_of(r['lv'],r['v_mean']))
    d=deep_feats(vs,aa,gs,r['len_km'])
    for k,vv in d.items():seg.at[i,k]=vv

ACQ=[c for c in ACQUIRABLE if c in seg.columns]
X=seg[ACQ+DEEP].fillna(seg[ACQ+DEEP].median())
y=seg['h2_per_km'];yphys=seg['h2_phys'];resid=seg['resid']
g=seg['trip']+seg['car']*100000

def hgb(): return HistGradientBoostingRegressor(max_iter=350,learning_rate=0.05,max_depth=5,l2_regularization=1.0,random_state=42)
def ridge(): return Pipeline([('sc',StandardScaler()),('m',Ridge(alpha=10.0))])

print('\n===== 按行程分组 5 折 CV（目标 h2_per_km, kg/km） =====')
# 物理单独
r2=r2_score(y,yphys);rm=np.sqrt(mean_squared_error(y,yphys))
print(f'物理单独              : R²={r2:+.3f}  RMSE={rm:.4f}')

# ML 单独 + 残差（hist / ridge）
for name,mk in [('ML单独(ACQ+DEEP)','base'),('物理+残差ML(HistGB)','hist'),('物理+残差ML(Ridge)','ridge')]:
    gkf=GroupKFold(5);r2s=[];rms=[]
    for tr,te in gkf.split(X,y,g):
        if mk=='base':
            m=hgb();m.fit(X.iloc[tr],y.iloc[tr]);p=m.predict(X.iloc[te]);p=np.maximum(p,0)
        elif mk=='hist':
            m=hgb();m.fit(X.iloc[tr],resid.iloc[tr]);p=yphys.iloc[te].values+np.maximum(m.predict(X.iloc[te]),-yphys.iloc[te].values)
        else:
            m=ridge();m.fit(X.iloc[tr],resid.iloc[tr]);p=yphys.iloc[te].values+m.predict(X.iloc[te]);p=np.maximum(p,0.01)
        r2s.append(r2_score(y.iloc[te],p));rms.append(np.sqrt(mean_squared_error(y.iloc[te],p)))
    print(f'{name:24s}: R²={np.mean(r2s):+.3f}±{np.std(r2s):.3f}  RMSE={np.mean(rms):.4f}')
