# -*- coding: utf-8 -*-
"""特征工程 + 工况合成（训练/预测共用同一份代码，保证 train/serve 一致）
速度统一为 km/h（实车 canData_speed 原始为 ×10，即 0.1km/h，入口处 ÷10）。
"""
import numpy as np
from collections import Counter

DT = 60.0  # 实车 60s 聚合

# 道路等级序数（与 SegmentData.roadLevel 对齐）
LV_ORDER = {"highway":0,"expressway":1,"national":2,"provincial":3,"county":4,"city":5,"other":6}

def lv_ordinal(level):
    if isinstance(level,(int,float)) and not isinstance(level,bool):
        return int(min(max(level,0),6))
    return LV_ORDER.get(str(level or "other"), 6)

def speed_bucket(v_kmh):
    """按均速分箱（km/h）"""
    if v_kmh < 30: return "low"
    if v_kmh < 60: return "mid"
    if v_kmh < 85: return "high"
    return "vhigh"

def bucket_of(lv, v_kmh):
    hw = "hwy" if lv_ordinal(lv) <= 1 else "road"
    return hw + "_" + speed_bucket(v_kmh)

# ---------- 深度特征（输入 v/a/坡度 序列 + 段长，输出段级特征） ----------
def deep_feats(vs, aa, gs, L):
    vs = np.asarray(vs, float); aa = np.asarray(aa, float); gs = np.asarray(gs, float)
    if len(vs) == 0:
        return {"v_std":0.0,"v_p85":0.0,"absa_mean":0.0,"a_p90":0.0,
                "cruise_ratio":0.0,"stop_ratio":0.0,"e_acc":0.0,"e_aero":0.0,"e_grade_up":0.0}
    return {
        "v_std": float(np.std(vs)),
        "v_p85": float(np.percentile(vs, 85)),
        "absa_mean": float(np.mean(np.abs(aa))),
        "a_p90": float(np.percentile(np.abs(aa), 90)),
        "cruise_ratio": float(np.mean(np.abs(aa) < 0.15)),
        "stop_ratio": float(np.mean(vs < 1.0)),
        "e_acc": float(np.sum(np.clip(vs*aa, 0, None)*DT)/L),
        "e_aero": float(np.sum(vs**3*DT)/L),
        "e_grade_up": float(np.sum(np.clip(vs*gs, 0, None)*DT)/L),
    }

# ---------- 工况合成：模板拼接（从片段库按桶随机抽 v 片段；加速度由 v 差分得到） ----------
def synth_segment(rng, v_mean_kmh, grade_mean, n_points, lib, bucket):
    """为一段路合成 60s 分辨率的 v/a 序列。
    v_mean_kmh: 段均速(km/h)；grade_mean: 段平均坡度(%)；n_points: 段内 60s 点数。
    lib: 片段库（每桶存 v 片段数组，km/h）；加速度 = Δv/Δt（60s，m/s²）。
    返回 (v_list, a_list, grade_list)"""
    v_mean = max(v_mean_kmh, 1.0)
    n = max(2, int(n_points))
    gs = np.full(n, float(grade_mean or 0.0))
    cands = lib.get(bucket) or lib.get("road_mid") or []
    if not cands:
        vv = np.full(n, v_mean)
        aa = np.zeros(n)
        return vv.tolist(), aa.tolist(), gs.tolist()
    pieces = []
    while sum(len(p) for p in pieces) < n:
        p = cands[int(rng.integers(0, len(cands)))]
        pieces.append(p)
    vs = np.concatenate(pieces)[:n]
    if len(vs) < n: vs = np.pad(vs, (0, n-len(vs)))
    vs = np.asarray(vs, float)
    if len(vs) > 2:
        vs = np.array([vs[0]] + [(vs[j-1]+2*vs[j]+vs[j+1])/4 for j in range(1, len(vs)-1)] + [vs[-1]])
    vs = vs * (1 - 0.025*gs)          # 坡度调制：上坡减、下坡加
    vs = np.clip(vs, 0, None)
    nz = vs > 0
    if nz.sum() > 0:
        vs[nz] = np.clip(vs[nz]*(v_mean*n/(nz.sum())/np.mean(vs[nz])), 0, v_mean*1.8)
    # 加速度：60s 平均速度差分 → m/s²（(km/h)/60s /3.6）
    aa = np.diff(vs, prepend=vs[0]) / 3.6 / DT
    return vs.tolist(), aa.tolist(), gs.tolist()

# ---------- 训练/预测共用的段特征装配 ----------
ACQUIRABLE = ["len_km","v_mean","grade_mean","elev_mean","temp_mean","wind_mean","hum_mean","hour","lv"]
DEEP = ["v_std","v_p85","absa_mean","a_p90","cruise_ratio","stop_ratio","e_acc","e_aero","e_grade_up"]
FEATURES = ACQUIRABLE + DEEP

def row_to_feature_vec(seg, deep_dict):
    """把一段(可获取特征 + 深度特征dict)拼成模型输入向量（顺序固定）"""
    base = [seg.get("len_km",5.0), seg.get("v_mean",60.0), seg.get("grade_mean",0.0),
            seg.get("elev_mean",100.0), seg.get("temp_mean",20.0), seg.get("wind_mean",10.0),
            seg.get("hum_mean",60.0), seg.get("hour",12.0), lv_ordinal(seg.get("lv","other"))]
    deep_v = [deep_dict[k] for k in DEEP]
    return base + deep_v
