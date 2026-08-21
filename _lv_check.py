# -*- coding: utf-8 -*-
"""按道路等级看实测段氢耗（kg/100km），对比模型预测是否合理"""
import pandas as pd, numpy as np, os, sys
os.environ.setdefault('LOKY_MAX_CPU_COUNT','1')
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ml'))
from collections import Counter
from ml.feat import lv_ordinal

def haversine(lat1,lon1,lat2,lon2):
    R=6371.0; p1,p2=np.radians([lat1,lat2]); dp=np.radians(lat2-lat1); dl=np.radians(lon2-lon1)
    a=np.sin(dp/2)**2+np.cos(p1[0])*np.cos(p1[1])*np.sin(dl/2)**2
    return 2*R*np.arcsin(np.sqrt(a))

def aggregate(d):
    lat=d["lat_纬度"].values/1e6; lon=d["lon_经度"].values/1e6
    t=pd.to_datetime(d.iloc[:,0],errors="coerce").values
    v=d["canData_speed_车速"].astype(float).values/10.0
    lv=d["road_level"].values
    h2rem=d["celDataExt_h2_remain_氢气剩余量"].astype(float).values
    h2used=-np.diff(h2rem, prepend=h2rem[0])
    h2used=np.where((h2used>0)&(h2used<1.0), h2used, 0.0)
    dt=np.full(len(d),0.0); dt[1:]=np.diff(t).astype("timedelta64[s]").astype(float)
    trip=(dt>300).cumsum()
    dist=np.zeros(len(d)); dist[1:]=haversine(lat[:-1],lon[:-1],lat[1:],lon[1:])
    cum=np.cumsum(dist); rows=[]
    for tr in np.unique(trip):
        idx=np.where(trip==tr)[0]
        c=cum[idx]-cum[idx][0]
        for sid in np.unique((c/5.0).astype(int)):
            s=idx[(c/5.0).astype(int)==sid]
            L=np.sum(dist[s])
            if L<0.3: continue
            rows.append({"lv":lv_ordinal(Counter(lv[s]).most_common(1)[0][0]),
                         "v_mean":np.mean(v[s]), "h2_per_km":np.sum(h2used[s])/L})
    return pd.DataFrame(rows)

s1=aggregate(pd.read_csv("_v1_feat.csv")); s2=aggregate(pd.read_csv("_v2_feat.csv"))
s=pd.concat([s1,s2],ignore_index=True)
s=s[(s["h2_per_km"]>0.02)&(s["h2_per_km"]<0.5)]
LVN={0:"高速",1:"快速路",2:"国道",3:"省道",4:"县乡道",5:"城市",6:"其他"}
print("按道路等级 · 实测段氢耗 (kg/100km)：")
print("  等级       段数  均速中位  氢耗中位  氢耗均值  P75  P90")
for lv in range(7):
    g=s[s["lv"]==lv]
    if len(g)<3: continue
    print("  %-6s %4d  %5.1f    %6.2f   %6.2f  %6.2f %6.2f"%(
        LVN[lv], len(g), g["v_mean"].median(), g["h2_per_km"].median()*100, g["h2_per_km"].mean()*100,
        g["h2_per_km"].quantile(0.75)*100, g["h2_per_km"].quantile(0.9)*100))
print("\n说明：模型预测的高速段≈4-5、城市段≈8-25 kg/100km；上表是实车实测值。")
