# -*- coding: utf-8 -*-
"""模型对比（与 train.py 管道完全一致）：多方法 + Stacking"""
import os, sys, json
os.environ.setdefault("LOKY_MAX_CPU_COUNT", "1"); os.environ.setdefault("OMP_NUM_THREADS", "1")
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import pandas as pd, numpy as np, warnings
warnings.filterwarnings("ignore")
from collections import Counter, defaultdict
from sklearn.ensemble import HistGradientBoostingRegressor, GradientBoostingRegressor, RandomForestRegressor, StackingRegressor
from sklearn.linear_model import Ridge, Lasso, ElasticNet
from sklearn.svm import SVR
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import GroupKFold
from sklearn.metrics import r2_score, mean_squared_error
from feat import deep_feats, synth_segment, bucket_of, lv_ordinal, ACQUIRABLE, DEEP, FEATURES

MASS = json.load(open(os.path.join(HERE, "mass_est.json"), encoding="utf-8"))
def mass_for(key, tr):
    m = MASS.get(key, {}); return float(m.get("trips", {}).get(str(tr), m.get("default_mass_kg", 30000.0)))
def hav(lat1,lon1,lat2,lon2):
    R=6371.0; p1=np.radians(lat1); p2=np.radians(lat2); dp=np.radians(lat2-lat1); dl=np.radians(lon2-lon1)
    return 2*R*np.arcsin(np.sqrt(np.sin(dp/2)**2+np.cos(p1)*np.cos(p2)*np.sin(dl/2)**2))
def aggregate(d, mass_key):
    lat=d["lat_纬度"].values/1e6; lon=d["lon_经度"].values/1e6
    t=pd.to_datetime(d.iloc[:,0],errors="coerce").values
    v=d["canData_speed_车速"].astype(float).values/10.0
    g=d["grade_pct"].astype(float).values; e=d["elev_m"].values
    tc=d["temp_c"].astype(float).values; wd=d["wind_kmh"].astype(float).values; hu=d["hum_pct"].astype(float).values
    lv=d["road_level"].values
    h2rem=d["celDataExt_h2_remain_氢气剩余量"].astype(float).values
    h2used=-np.diff(h2rem, prepend=h2rem[0]); h2used=np.where((h2used>0)&(h2used<1.0),h2used,0.0)
    dt=np.full(len(d),0.0); dt[1:]=np.diff(t).astype("timedelta64[s]").astype(float)
    trip=(dt>300).cumsum()
    dist=np.zeros(len(d)); dist[1:]=hav(lat[:-1],lon[:-1],lat[1:],lon[1:])
    cum=np.cumsum(dist); rows=[]
    for tr in np.unique(trip):
        idx=np.where(trip==tr)[0]; c=cum[idx]-cum[idx][0]
        for sid in np.unique((c/5.0).astype(int)):
            s=idx[(c/5.0).astype(int)==sid]; L=np.sum(dist[s])
            if L<0.3: continue
            w=dist[s]/L if L>0 else np.full(len(s),1.0/len(s))
            es=e[s]; _gain=0.0
            for _j in range(1,len(s)):
                if np.isfinite(es[_j]) and np.isfinite(es[_j-1]):
                    _dh=es[_j]-es[_j-1]
                    if _dh>0: _gain+=_dh
            rows.append({"trip":int(tr),"len_km":L,"v_series":v[s].tolist(),
                "v_mean":float(np.sum(w*v[s])),"grade_mean":float(np.sum(w*g[s])),
                "gain_m_per_km":round(_gain/L,2) if L>0 else 0.0,
                "elev_mean":float(np.sum(w*e[s])),"temp_mean":float(np.sum(w*tc[s])),
                "wind_mean":float(np.sum(w*wd[s])),"hum_mean":float(np.sum(w*hu[s])),
                "lv":lv_ordinal(Counter(lv[s]).most_common(1)[0][0]),
                "mass_kg":mass_for(mass_key,int(tr)),"hour":int(pd.Timestamp(t[s[0]]).hour),
                "h2_per_km":float(np.sum(h2used[s])/L)})
    return pd.DataFrame(rows)

s1=aggregate(pd.read_csv(os.path.join(os.path.dirname(HERE),"_v1_feat.csv"),encoding="utf-8-sig"),"V1")
s2=aggregate(pd.read_csv(os.path.join(os.path.dirname(HERE),"_v2_feat.csv"),encoding="utf-8-sig"),"V2")
s1["car"]=0; s2["car"]=1
s=pd.concat([s1,s2],ignore_index=True)
s=s[(s["h2_per_km"]>0.02)&(s["h2_per_km"]<0.5)&(s["len_km"]>=1)]
print("段数:", len(s))

lib=defaultdict(list)
for _,r in s.iterrows(): lib[bucket_of(r["lv"],r["v_mean"])].append(np.array(r["v_series"],float))
rng=np.random.default_rng(42)
for i,r in s.iterrows():
    n=len(r["v_series"]); vs,aa,gs=synth_segment(rng,r["v_mean"],r["grade_mean"],n,lib,bucket_of(r["lv"],r["v_mean"]))
    dd=deep_feats(vs,aa,gs,r["len_km"])
    for k in DEEP: s.at[i,k]=dd[k]
X=s[FEATURES].fillna(0); y=s["h2_per_km"].values; groups=s["trip"].values+s["car"].values*100000

gkf=GroupKFold(5)
def cv_run(make_model):
    r2s=[]; rms=[]
    for tr,te in gkf.split(X,y,groups):
        m=make_model(); m.fit(X.iloc[tr],y[tr]); p=m.predict(X.iloc[te])
        r2s.append(r2_score(y[te],p)); rms.append(np.sqrt(mean_squared_error(y[te],p)))
    return np.mean(r2s), np.mean(rms)

print("=== 与 train.py 管道一致：按行程分组 5 折 CV ===")
for name, mk in [
    ("HistGB", lambda: HistGradientBoostingRegressor(max_iter=350,learning_rate=0.05,max_depth=5,l2_regularization=1.0,random_state=42)),
    ("GBR", lambda: GradientBoostingRegressor(n_estimators=350,learning_rate=0.05,max_depth=5,random_state=42)),
    ("RandomForest", lambda: RandomForestRegressor(n_estimators=300,max_depth=8,random_state=42,n_jobs=1)),
    ("Ridge", lambda: make_pipeline(StandardScaler(), Ridge(alpha=1.0))),
    ("Lasso", lambda: make_pipeline(StandardScaler(), Lasso(alpha=0.001,max_iter=5000))),
    ("ElasticNet", lambda: make_pipeline(StandardScaler(), ElasticNet(alpha=0.001,l1_ratio=0.5,max_iter=5000))),
    ("SVR", lambda: make_pipeline(StandardScaler(), SVR(C=10,epsilon=0.01))),
    ("MLP", lambda: make_pipeline(StandardScaler(), MLPRegressor(hidden_layer_sizes=(64,32),max_iter=500,early_stopping=True,random_state=42))),
]:
    r2, rmse = cv_run(mk)
    print("%-14s R²=%.4f RMSE=%.4f" % (name, r2, rmse))

def make_stack():
    return StackingRegressor(
        estimators=[("hist",HistGradientBoostingRegressor(max_iter=350,learning_rate=0.05,max_depth=5,l2_regularization=1.0,random_state=42)),
                    ("gbr",GradientBoostingRegressor(n_estimators=200,learning_rate=0.05,max_depth=4,random_state=42)),
                    ("ridge",Ridge(alpha=1.0))], final_estimator=Ridge(alpha=1.0), cv=5, n_jobs=1)
r2, rmse = cv_run(make_stack)
print("%-14s R²=%.4f RMSE=%.4f" % ("Stacking", r2, rmse))
