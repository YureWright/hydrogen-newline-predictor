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

def predict_segment(seg, rng, hour_default=12):
    ensure()
    L = float(seg.get("distanceKm") or seg.get("len_km") or 5.0)
    v_mean = float(seg.get("avgSpeedKmh") or seg.get("v_mean") or 60.0)
    grade = float(seg.get("gradePercent") if seg.get("gradePercent") is not None else seg.get("grade_mean", 0.0) or 0.0)
    elev = float(seg.get("elevationM") if seg.get("elevationM") is not None else seg.get("elev_mean", 100.0) or 100.0)
    temp = float(seg.get("temperatureC") if seg.get("temperatureC") is not None else seg.get("temp_mean", 20.0) or 20.0)
    wind = float(seg.get("windSpeedKmh") if seg.get("windSpeedKmh") is not None else seg.get("wind_mean", 10.0) or 10.0)
    hum  = float(seg.get("humidityPct") if seg.get("humidityPct") is not None else seg.get("hum_mean", 60.0) or 60.0)
    hour = int(seg.get("hour", hour_default) or hour_default)
    lv   = lv_ordinal(seg.get("roadLevel") or seg.get("lv") or "other")
    n_points = max(2, int(round(L / (max(v_mean, 5.0) / 60.0))))
    vs, aa, gs = synth_segment(rng, v_mean, grade, n_points, lib, bucket_of(lv, v_mean))
    deep = deep_feats(vs, aa, gs, L)
    feats = {"len_km": L, "v_mean": v_mean, "grade_mean": grade, "elev_mean": elev,
             "temp_mean": temp, "wind_mean": wind, "hum_mean": hum, "hour": hour, "lv": lv}
    X = np.array([feats[k] for k in ACQUIRABLE] + [deep[k] for k in DEEP]).reshape(1, -1)
    h2_per_km_kg = float(model.predict(X)[0])
    # 均速校准：模型对低速段（城市/拥堵）系统性高估（训练 CV 实测：0-40km/h +1.6、40-60 +0.9、
    # 60-80 +0.3、80+ +0.5 kg/100km；整体平均误差 +1.2%）。
    # 用分段线性偏差修正，低速多减、高速少减：
    #   bias(v) = clip(1.8 - 0.02·v, 0, 1.8)  kg/100km
    bias_100 = max(0.0, 1.8 - 0.02 * v_mean)
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
