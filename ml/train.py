# -*- coding: utf-8 -*-
"""训练段级氢耗模型（合成工况特征，产品闭环版）
读取实车 60s 数据(已含坡度/海拔/温度/道路等级等回填特征) → 5km 段聚合
→ 工况合成深度特征 → HistGB 训练 → 导出 model.joblib + 模板片段库 + 元数据。
"""
import os
os.environ.setdefault('LOKY_MAX_CPU_COUNT', '1')
os.environ.setdefault('OMP_NUM_THREADS', '1')
import pandas as pd, numpy as np, json, sys, os, warnings, datetime
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
warnings.filterwarnings("ignore")
from collections import defaultdict, Counter
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.model_selection import GroupKFold
from sklearn.metrics import r2_score, mean_squared_error
from feat import (deep_feats, synth_segment, bucket_of, lv_ordinal,
                  ACQUIRABLE, DEEP, FEATURES)

print = lambda *a: sys.stdout.write(" ".join(map(str,a))+"\n") or sys.stdout.flush()

Y = "h2_consum_per_sec"   # 保留列名（内部不再用它做目标）
V1 = os.path.join(HERE, "..", "_v1_feat.csv")
V2 = os.path.join(HERE, "..", "_v2_feat.csv")
OUT_MODEL = os.path.join(HERE, "model.joblib")
OUT_TEMPLATES = os.path.join(HERE, "templates.json")
OUT_META = os.path.join(HERE, "meta.json")

def haversine(lat1,lon1,lat2,lon2):
    R=6371.0; p1,p2=np.radians(lat1),np.radians(lat2); dp=np.radians(lat2-lat1); dl=np.radians(lon2-lon1)
    a=np.sin(dp/2)**2+np.cos(p1)*np.cos(p2)*np.sin(dl/2)**2
    return 2*R*np.arcsin(np.sqrt(a))

def aggregate(d):
    """60s 点 → 5km 段（速度统一 km/h：canData_speed 原始 ×10）"""
    lat=d["lat_纬度"].values/1e6; lon=d["lon_经度"].values/1e6
    t=pd.to_datetime(d.iloc[:,0],errors="coerce").values
    v=d["canData_speed_车速"].astype(float).values/10.0   # ×10 → km/h
    # 注意：H49Data_longitudinal_acc 列实际是经度（清洗错位），加速度由 60s 平均速度差分得到 (m/s²)
    a=np.diff(v, prepend=v[0])/3.6/60.0
    g=d["grade_pct"].astype(float).values; e=d["elev_m"].values
    tc=d["temp_c"].astype(float).values; w=d["wind_kmh"].astype(float).values; hu=d["hum_pct"].astype(float).values
    lv=d["road_level"].values
    # 真实目标：氢气剩余量差分（kg/60s）；加氢跳变/噪声剔除
    h2rem=d["celDataExt_h2_remain_氢气剩余量"].astype(float).values
    h2used=-np.diff(h2rem, prepend=h2rem[0])
    h2used=np.where((h2used>0)&(h2used<1.0), h2used, 0.0)   # 有效消耗 0~1 kg/60s
    dt=np.full(len(d),0.0); dt[1:]=np.diff(t).astype("timedelta64[s]").astype(float)
    trip=(dt>300).cumsum()
    dist=np.zeros(len(d)); dist[1:]=haversine(lat[:-1],lon[:-1],lat[1:],lon[1:])
    cum=np.cumsum(dist)
    DT=60.0
    rows=[]
    for tr in np.unique(trip):
        idx=np.where(trip==tr)[0]
        c=cum[idx]-cum[idx][0]
        for sid in np.unique((c/5.0).astype(int)):
            s=idx[(c/5.0).astype(int)==sid]
            L=np.sum(dist[s])
            if L<0.3: continue
            rows.append({
                "trip":int(tr),"len_km":L,
                "v_series":v[s].tolist(),"a_series":a[s].tolist(),
                "v_mean":float(np.mean(v[s])),"grade_mean":float(np.mean(g[s])),
                "elev_mean":float(np.mean(e[s])),"temp_mean":float(np.mean(tc[s])),
                "wind_mean":float(np.mean(w[s])),"hum_mean":float(np.mean(hu[s])),
                "lv":lv_ordinal(Counter(lv[s]).most_common(1)[0][0]),
                "hour":int(pd.Timestamp(t[s[0]]).hour),
                "h2_per_km":float(np.sum(h2used[s])/L)})
    return pd.DataFrame(rows)

print("加载实车数据并聚合 5km 段（速度→km/h）...")
s1=aggregate(pd.read_csv(V1)); s2=aggregate(pd.read_csv(V2))
s1["car"]=0; s2["car"]=1
s=pd.concat([s1,s2],ignore_index=True)
s=s[(s["h2_per_km"]>0.02)&(s["h2_per_km"]<0.5)&(s["len_km"]>=1)]
print("段数:",len(s),"| 均速分布:",s["v_mean"].describe().round(1)[["mean","50%","min","max"]].to_dict())
print("真实目标 h2_per_km(kg/km):",s["h2_per_km"].describe().round(4)[["mean","50%","min","max"]].to_dict(),"→ 百公里",round(s["h2_per_km"].median()*100,2),"kg/100km")

# 片段库：按 等级×均速 桶，存 (v_kmh_arr, a_arr)
lib=defaultdict(list)
for _,r in s.iterrows():
    b=bucket_of(r["lv"],r["v_mean"])
    lib[b].append(np.array(r["v_series"],float))  # 只存 v（合成时 a 由 v 差分得到）
print("片段库桶:",{k:len(v) for k,v in lib.items()})

# 每段合成深度特征（固定随机种子，保证可复现）
rng=np.random.default_rng(42)
def synth_feats_for(row):
    n=len(row["v_series"])
    vs,aa,gs=synth_segment(rng, row["v_mean"], row["grade_mean"], n, lib, bucket_of(row["lv"],row["v_mean"]))
    return deep_feats(vs,aa,gs,row["len_km"])
for i,r in s.iterrows():
    d=synth_feats_for(r)
    for k,v in d.items(): s.at[i,k]=v

X=s[FEATURES].fillna(0); y=s["h2_per_km"]
groups=s["trip"]+s["car"]*100000

# 训练（全量） + 按行程分组 CV 报告
model=HistGradientBoostingRegressor(max_iter=350,learning_rate=0.05,max_depth=5,l2_regularization=1.0,random_state=42)
model.fit(X,y)
gkf=GroupKFold(5); r2s=[]; rms=[]
for tr,te in gkf.split(X,y,groups):
    m=HistGradientBoostingRegressor(max_iter=350,learning_rate=0.05,max_depth=5,l2_regularization=1.0,random_state=42)
    m.fit(X.iloc[tr],y.iloc[tr]); p=m.predict(X.iloc[te])
    r2s.append(r2_score(y.iloc[te],p)); rms.append(np.sqrt(mean_squared_error(y.iloc[te],p)))
print("\n按行程分组 CV: R2=%.4f±%.4f RMSE=%.4f kg/km"%(np.mean(r2s),np.std(r2s),np.mean(rms)))

# 导出
import joblib
joblib.dump(model, OUT_MODEL)
json.dump({k:[a.tolist() for a in v] for k,v in lib.items()}, open(OUT_TEMPLATES,"w",encoding="utf-8"))
json.dump({"features":FEATURES,"units":{"speed":"km/h","h2":"kg/km","target":"h2_remain_diff"},"trained_at": datetime.date.today().isoformat(),"n_segments":int(len(s)),
           "cv":{"r2_mean":float(np.mean(r2s)),"rmse_mean":float(np.mean(rms))}}, open(OUT_META,"w",encoding="utf-8"), ensure_ascii=False, indent=2)
print("已导出:",OUT_MODEL,OUT_TEMPLATES,OUT_META)
