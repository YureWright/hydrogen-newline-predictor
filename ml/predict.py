# -*- coding: utf-8 -*-
"""预测入口：stdin 收段特征 JSON → 工况合成 → 段级模型 → stdout 每段氢耗 + 总计
输入格式: {"departure_hour": 8, "segments": [ {distanceKm, avgSpeedKmh, gradePercent, elevationM,
          temperatureC, windSpeedKmh, humidityPct, roadLevel, hour} ]}
输出: {"ok":true, "total_h2_kg":.., "per100km_kg":.., "segments":[{index,distanceKm,h2_per_km, h2_g}]}
"""
import sys, os, json
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
# stdin/stdout 统一 UTF-8（Node 侧按 utf8 编码写入/解码；避免 Windows GBK 下中文损坏或报错）
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
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
        model = joblib.load(MODEL)   # 可能是 StackingRegressor（含 hist+gbr+ridge）
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
    # 爬升密度：前端传总爬升 gainM(m)，除以段长得 m/km（与训练聚合口径一致）
    gain_m = float(_get(seg, "gainM", "elevationGainM", 0.0))
    gain_m_per_km = gain_m / L if L > 0 else 0.0
    n_points = max(2, int(round(L / (max(v_mean, 5.0) / 60.0))))
    vs, aa, gs = synth_segment(rng, v_mean, grade, n_points, lib, bucket_of(lv, v_mean))
    deep = deep_feats(vs, aa, gs, L)
    feats = {"len_km": L, "v_mean": v_mean, "grade_mean": grade, "gain_m_per_km": gain_m_per_km, "elev_mean": elev, "mass_kg": mass_kg,
             "temp_mean": temp, "wind_mean": wind, "hum_mean": hum, "hour": hour, "lv": lv}
    X = np.array([feats[k] for k in ACQUIRABLE] + [deep[k] for k in DEEP]).reshape(1, -1)
    h2_per_km_kg = float(model.predict(X)[0])
    # 防御性截断：下限 0，上限 0.5 kg/km（=50 kg/100km，与训练数据过滤上界一致，
    # 满载重卡爬陡坡极限）；只挡异常外推，不误伤 20~50 kg/100km 的合理高耗段。
    h2_per_km_kg = max(min(h2_per_km_kg, 0.5), 0.0)
    h2_kg = h2_per_km_kg * L
    return {
      "index": seg.get("index", 0),
      "roadName": seg.get("roadName", ""),
      "distanceKm": round(L, 2),
      "avgSpeedKmh": round(v_mean, 1),
      "gradePercent": round(grade, 2),
      "elevationM": round(elev, 0),
      "temperatureC": round(temp, 1),
      "windSpeedKmh": round(wind, 1),
      "windDirDeg": seg.get("windDirDeg"),
      "windDirText": seg.get("windDirText") or "",
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
