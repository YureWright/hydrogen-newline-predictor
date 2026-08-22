# -*- coding: utf-8 -*-
"""校准检查：训练段上 交叉验证预测 vs 实测 的偏差"""
import pandas as pd, numpy as np, os, sys, warnings, json
warnings.filterwarnings("ignore")
os.environ.setdefault('LOKY_MAX_CPU_COUNT','1')
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from collections import Counter, defaultdict
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.model_selection import GroupKFold
from feat import deep_feats, synth_segment, bucket_of, lv_ordinal, ACQUIRABLE, DEEP, FEATURES

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
    g=d["grade_pct"].astype(float).values; e=d["elev_m"].values
    tc=d["temp_c"].astype(float).values; w=d["wind_kmh"].astype(float).values; hu=d["hum_pct"].astype(float).values
    lv=d["road_level"].values
    h2rem=d["celDataExt_h2_remain_氢气剩余量"].astype(float).values
    h2used=-np.diff(h2rem, prepend=h2rem[0]); h2used=np.where((h2used>0)&(h2used<1.0),h2used,0.0)
    dt=np.full(len(d),0.0); dt[1:]=np.diff(t).astype("timedelta64[s]").astype(float)
    trip=(dt>300).cumsum()
    dist=np.zeros(len(d)); dist[1:]=haversine(lat[:-1],lon[:-1],lat[1:],lon[1:])
    cum=np.cumsum(dist); rows=[]
    for tr in np.unique(trip):
        idx=np.where(trip==tr)[0]; c=cum[idx]-cum[idx][0]
        for sid in np.unique((c/5.0).astype(int)):
            s=idx[(c/5.0).astype(int)==sid]; L=np.sum(dist[s])
            if L<0.3: continue
            rows.append({"trip":int(tr),"len_km":L,"v_series":v[s].tolist(),
                "v_mean":float(np.mean(v[s])),"grade_mean":float(np.mean(g[s])),"elev_mean":float(np.mean(e[s])),
                "temp_mean":float(np.mean(tc[s])),"wind_mean":float(np.mean(w[s])),"hum_mean":float(np.mean(hu[s])),
                "lv":lv_ordinal(Counter(lv[s]).most_common(1)[0][0]),
                "mass_kg": mass_for(mass_key, int(tr)),"hour":int(pd.Timestamp(t[s[0]]).hour),
                "h2_per_km":float(np.sum(h2used[s])/L)})
    return pd.DataFrame(rows)

s1=aggregate(pd.read_csv("_v1_feat.csv"), "V1"); s2=aggregate(pd.read_csv("_v2_feat.csv"), "V2")
s1["car"]=0; s2["car"]=1
s=pd.concat([s1,s2],ignore_index=True)
s=s[(s["h2_per_km"]>0.02)&(s["h2_per_km"]<0.5)&(s["len_km"]>=1)]
lib=defaultdict(list)
for _,r in s.iterrows(): lib[bucket_of(r["lv"],r["v_mean"])].append(np.array(r["v_series"],float))
rng=np.random.default_rng(42)
for i,r in s.iterrows():
    n=len(r["v_series"]); vs,aa,gs=synth_segment(rng,r["v_mean"],r["grade_mean"],n,lib,bucket_of(r["lv"],r["v_mean"]))
    dd=deep_feats(vs,aa,gs,r["len_km"])
    for k in DEEP: s.at[i,k]=dd[k]
X=s[FEATURES].fillna(0); y=s["h2_per_km"]; groups=s["trip"]+s["car"]*100000
pred=np.zeros(len(s))
gkf=GroupKFold(5)
for tr,te in gkf.split(X,y,groups):
    m=HistGradientBoostingRegressor(max_iter=350,learning_rate=0.05,max_depth=5,l2_regularization=1.0,random_state=42)
    m.fit(X.iloc[tr],y.iloc[tr]); pred[te]=m.predict(X.iloc[te])
err=pred-y
print("训练段 CV 预测 vs 实测：")
print("  平均误差(预测-实测): %+.4f kg/km (%+.2f kg/100km)" % (err.mean(), err.mean()*100))
print("  相对误差: %+.1f%%" % (err.mean()/y.mean()*100))
print("  实测中位 %.2f | 预测中位 %.2f kg/100km" % (y.median()*100, np.median(pred)*100))
# 按均速看偏差
print("\n按均速段看偏差：")
for lo,hi in [(0,40),(40,60),(60,80),(80,120)]:
    m=(s["v_mean"]>=lo)&(s["v_mean"]<hi)
    if m.sum()<3: continue
    e=err[m]
    print("  均速 %2d-%2d km/h | n=%3d | 实测中位 %5.2f | 预测中位 %5.2f | 偏差 %+5.2f kg/100km" % (
        lo,hi,m.sum(),y[m].median()*100,np.median(pred[m])*100,np.median(e)*100))
