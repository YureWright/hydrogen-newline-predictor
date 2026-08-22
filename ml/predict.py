# -*- coding: utf-8 -*-
"""预测入口：stdin 收段特征 JSON → 工况合成 → 段级模型 → stdout 每段氢耗 + 总计
输入格式: {"departure_hour": 8, "segments": [ {distanceKm, avgSpeedKmh, gradePercent, elevationM,
          temperatureC, windSpeedKmh, humidityPct, roadLevel, hour} ]}
输出: {"ok":true, "total_h2_kg":.., "per100km_kg":.., "segments":[{index,distanceKm,h2_per_km, h2_g}]}
"""
import sys, os, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import numpy as np
import joblib
from feat import (deep_feats, synth_segment, bucket_of, lv_ordinal,
                  ACQUIRABLE, DEEP, FEATURES)

MODEL = os.path.join(HERE, "model.joblib")
TPL = os.path.join(HERE, "templates.json")

def load_lib():
    raw = json.load(open(TPL, encoding="utf-8"))
    return {k: [np.array(a, float) for a in v] for k, v in raw.items()}

model = None
lib = None
def ensure():
    global model, lib
    if model is None:
        model = joblib.load(MODEL)
        lib = load_lib()

def _get(seg, key1, key2, default):
    """取值：key1 优先，key2 兜底；只有 None 才用默认值（0 是合法值，不能当缺失）"""
    v = seg.get(key1)
    if v is not None:
        return v
    v = seg.get(key2)
    if v is not None:
        return v
    return default

def predict_segment(seg, rng, hour_default=12):
    ensure()
    L = float(_get(seg, "distanceKm", "len_km", 5.0))
    v_mean = float(_get(seg, "avgSpeedKmh", "v_mean", 60.0))
    grade = float(_get(seg, "gradePercent", "grade_mean", 0.0))
    elev = float(_get(seg, "elevationM", "elev_mean", 100.0))
    temp = float(_get(seg, "temperatureC", "temp_mean", 20.0))
    wind = float(_get(seg, "windSpeedKmh", "wind_mean", 10.0))
    hum  = float(_get(seg, "humidityPct", "hum_mean", 60.0))
    hour = int(_get(seg, "hour", None, hour_default))
    lv   = lv_ordinal(_get(seg, "roadLevel", "lv", "other"))
    mass_kg = float(_get(seg, "massKg", "totalMassKg", 30000.0))
    n_points = max(2, int(round(L / (max(v_mean, 5.0) / 60.0))))
    vs, aa, gs = synth_segment(rng, v_mean, grade, n_points, lib, bucket_of(lv, v_mean))
    deep = deep_feats(vs, aa, gs, L)
    feats = {"len_km": L, "v_mean": v_mean, "grade_mean": grade, "elev_mean": elev, "mass_kg": mass_kg,
             "temp_mean": temp, "wind_mean": wind, "hum_mean": hum, "hour": hour, "lv": lv}
    X = np.array([feats[k] for k in ACQUIRABLE] + [deep[k] for k in DEEP]).reshape(1, -1)
    h2_per_km_kg = float(model.predict(X)[0])
    # 均速校准：HistGB 输出是条件期望（均值），而氢耗目标右偏（长尾），低速段高估最明显。
    # 2026-08-22 重训后按行程分组 CV 实测偏差（无校准）：0-40 +0.76、40-60 +0.96、
    # 60-80 +0.09、80+ +0.50 kg/100km；整体 +1.0%。用分段常数把均值估计拉回中位水平：
    #   bias(v) = 0.76 (v<40) / 0.96 (40<=v<60) / 0.09 (60<=v<80) / 0.50 (v>=80)
    if v_mean < 40:   bias_100 = 0.76
    elif v_mean < 60: bias_100 = 0.96
    elif v_mean < 80: bias_100 = 0.09
    else:             bias_100 = 0.50
    h2_per_km_kg = max(h2_per_km_kg - bias_100 / 100.0, 0.0)
    h2_kg = max(h2_per_km_kg, 0.0) * L
    return {
      "index": seg.get("index", 0),
      "roadName": seg.get("roadName", ""),
      "distanceKm": round(L, 2),
      "avgSpeedKmh": round(v_mean, 1),
      "gradePercent": round(grade, 2),
      "elevationM": round(elev, 0),
      "temperatureC": round(temp, 1),
      "windSpeedKmh": round(wind, 1),
      "humidityPct": round(hum, 0),
      "roadLevel": seg.get("roadLevel") or "other",
      "massKg": round(mass_kg, 0),
      # 合成深度工况字段
      "v_std": round(deep["v_std"], 2),
      "v_p85": round(deep["v_p85"], 1),
      "absa_mean": round(deep["absa_mean"], 3),
      "a_p90": round(deep["a_p90"], 3),
      "cruise_ratio": round(deep["cruise_ratio"], 3),
      "stop_ratio": round(deep["stop_ratio"], 3),
      "e_acc": round(deep["e_acc"], 3),
      "e_aero": round(deep["e_aero"], 2),
      "e_grade_up": round(deep["e_grade_up"], 3),
      "h2_per_km_kg": round(max(h2_per_km_kg, 0.0), 4),
      "h2_kg": round(h2_kg, 3),
    }

def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw or "{}")
    except Exception as e:
        print(json.dumps({"ok": False, "msg": "JSON 解析失败: " + str(e)}, ensure_ascii=False)); return
    segs = payload.get("segments") or []
    hour_default = int(payload.get("departure_hour", 12) or 12)
    rng = np.random.default_rng(2026)
    out = [predict_segment(s, rng, hour_default) for s in segs]
    total_kg = sum(s["h2_kg"] for s in out)
    total_km = sum(s["distanceKm"] for s in out)
    print(json.dumps({
        "ok": True,
        "total_h2_kg": round(total_kg, 3),
        "per100km_kg": round(total_kg/(total_km/100.0), 2) if total_km > 0 else 0,
        "segments": out,
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
