# -*- coding: utf-8 -*-
"""生成训练报告：每特征与目标相关性 + 特征重要性（真实数据，不造假）"""
import os
os.environ.setdefault('LOKY_MAX_CPU_COUNT', '1')
os.environ.setdefault('OMP_NUM_THREADS', '1')
import pandas as pd, numpy as np, json, sys, os, warnings
warnings.filterwarnings("ignore")
from collections import Counter, defaultdict
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, ".."))
from ml.feat import (deep_feats, synth_segment, bucket_of, lv_ordinal,
                     ACQUIRABLE, DEEP, FEATURES)
print = lambda *a: sys.stdout.write(" ".join(map(str,a))+"\n") or sys.stdout.flush()

Y = "h2_consum_per_sec"
V1 = os.path.join(HERE, "..", "_v1_feat.csv")
V2 = os.path.join(HERE, "..", "_v2_feat.csv")

def haversine(lat1,lon1,lat2,lon2):
    R=6371.0; p1,p2=np.radians(lat1),np.radians(lat2); dp=np.radians(lat2-lat1); dl=np.radians(lon2-lon1)
    a=np.sin(dp/2)**2+np.cos(p1)*np.cos(p2)*np.sin(dl/2)**2
    return 2*R*np.arcsin(np.sqrt(a))

MASS = json.load(open(os.path.join(HERE, "mass_est.json"), encoding="utf-8")) if os.path.exists(os.path.join(HERE, "mass_est.json")) else {}

def mass_for(key, tr):
    m = MASS.get(key, {})
    return float(m.get("trips", {}).get(str(tr), m.get("default_mass_kg", 30000.0)))

def aggregate(d, mass_key):
    lat=d["lat_纬度"].values/1e6; lon=d["lon_经度"].values/1e6
    t=pd.to_datetime(d.iloc[:,0],errors="coerce").values
    v=d["canData_speed_车速"].astype(float).values/10.0
    a=d["H49Data_longitudinal_acc_纵向加速度"].astype(float).values
    g=d["grade_pct"].astype(float).values; e=d["elev_m"].values
    tc=d["temp_c"].astype(float).values; w=d["wind_kmh"].astype(float).values; hu=d["hum_pct"].astype(float).values
    lv=d["road_level"].values
    h2rem=d["celDataExt_h2_remain_氢气剩余量"].astype(float).values
    h2used=-np.diff(h2rem, prepend=h2rem[0])
    h2used=np.where((h2used>0)&(h2used<1.0), h2used, 0.0)
    dt=np.full(len(d),0.0); dt[1:]=np.diff(t).astype("timedelta64[s]").astype(float)
    trip=(dt>300).cumsum()
    dist=np.zeros(len(d)); dist[1:]=haversine(lat[:-1],lon[:-1],lat[1:],lon[1:])
    cum=np.cumsum(dist); DT=60.0
    rows=[]
    for tr in np.unique(trip):
        idx=np.where(trip==tr)[0]
        c=cum[idx]-cum[idx][0]
        for sid in np.unique((c/5.0).astype(int)):
            s=idx[(c/5.0).astype(int)==sid]
            L=np.sum(dist[s])
            if L<0.3: continue
            rows.append({"trip":int(tr),"len_km":L,
                "v_series":v[s].tolist(),"a_series":a[s].tolist(),"g_series":g[s].tolist(),
                "v_mean":float(np.mean(v[s])),"grade_mean":float(np.mean(g[s])),
                "elev_mean":float(np.mean(e[s])),"temp_mean":float(np.mean(tc[s])),
                "wind_mean":float(np.mean(w[s])),"hum_mean":float(np.mean(hu[s])),
                "lv":lv_ordinal(Counter(lv[s]).most_common(1)[0][0]),
                "mass_kg": mass_for(mass_key, int(tr)),
                "hour":int(pd.Timestamp(t[s[0]]).hour),
                "h2_per_km":float(np.sum(h2used[s])/L)})
    return pd.DataFrame(rows)

print("聚合 5km 段...")
s1=aggregate(pd.read_csv(V1), "V1"); s2=aggregate(pd.read_csv(V2), "V2")
s1["car"]=0; s2["car"]=1
s=pd.concat([s1,s2],ignore_index=True)
s=s[(s["h2_per_km"]>0.02)&(s["h2_per_km"]<0.5)&(s["len_km"]>=1)]

# 片段库（与训练一致）
lib=defaultdict(list)
for _,r in s.iterrows():
    b=bucket_of(r["lv"],r["v_mean"])
    lib[b].append(np.array(r["v_series"],float))

# 实测深度特征 + 合成深度特征
rng=np.random.default_rng(42)
for i,r in s.iterrows():
    varr=np.array(r["v_series"],float)
    aarr=np.diff(varr, prepend=varr[0])/3.6/60.0  # 加速度：v 差分（m/s²），H49 列是经度错位
    mdf=deep_feats(varr, aarr, r["g_series"], r["len_km"])
    n=len(r["v_series"])
    vs,aa,gs=synth_segment(rng, r["v_mean"], r["grade_mean"], n, lib, bucket_of(r["lv"],r["v_mean"]))
    sdf=deep_feats(vs,aa,gs,r["len_km"])
    for k in DEEP:
        s.at[i,"m_"+k]=mdf[k]
        s.at[i,"s_"+k]=sdf[k]
        s.at[i,k]=sdf[k]  # 训练用的合成特征列

y=s["h2_per_km"]
def pear(a,b):
    a=np.asarray(a,float); b=np.asarray(b,float)
    if np.std(a)==0 or np.std(b)==0: return float("nan")
    return float(np.corrcoef(a,b)[0,1])

report={"n_segments":int(len(s)),"target":"h2_per_km (kg/km)","target_mean":round(float(y.mean()),4),
        "target_median":round(float(y.median()),4),"target_per100km_median_kg":round(float(y.median()*100),2)}
print("\n=== 可获取特征 vs 目标 (Pearson r) ===")
report["acquirable_corr"]={}
for k in ACQUIRABLE:
    r=pear(s[k],y); report["acquirable_corr"][k]=round(r,3)
    print("   %-12s r=%+.3f"%(k,r))
print("\n=== 实测深度特征 vs 目标 ===")
report["real_deep_corr"]={}
for k in DEEP:
    r=pear(s["m_"+k],y); report["real_deep_corr"][k]=round(r,3)
    print("   %-12s r=%+.3f"%(k,r))
print("\n=== 合成深度特征 vs 目标 ===")
report["synth_deep_corr"]={}
for k in DEEP:
    r=pear(s["s_"+k],y); report["synth_deep_corr"][k]=round(r,3)
    print("   %-12s r=%+.3f"%(k,r))

# 特征重要性：加载已训练模型 + permutation importance
import joblib
from sklearn.inspection import permutation_importance
X=s[FEATURES].fillna(0)
model=joblib.load(os.path.join(HERE,"model.joblib"))
pi=permutation_importance(model,X,y,n_repeats=10,random_state=42,scoring="r2")
imp=sorted(zip(FEATURES,pi.importances_mean),key=lambda t:-t[1])
print("\n=== 特征重要性（permutation, 对训练好的模型）===")
report["permutation_importance"]={k:round(v,4) for k,v in imp}
for k,v in imp:
    print("   %-12s %.4f"%(k,v))

json.dump(report, open(os.path.join(HERE,"training_report.json"),"w",encoding="utf-8"), ensure_ascii=False, indent=2)
print("\n已保存 ml/training_report.json")
