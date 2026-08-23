# -*- coding: utf-8 -*-
"""物理氢耗模型引擎（PhysicsEngine）
输入：SegmentData（与 ml/predict.py 同一数据接口）
  {distanceKm, avgSpeedKmh, gradePercent, elevationM, temperatureC,
   windSpeedKmh, windDirDeg, windAffects, headingDeg, humidityPct, roadLevel, massKg, gainM}
计算：四阻力 → 总力 → 轮边功率 → 驱动电功率(含附件) → 电堆/电池削峰 → 电堆效率 → 氢耗
输出：每段含全部中间变量（英文 key，中文名见 VAR_CN）+ 总计
参考：docs/物理氢耗模型_设计方案.html（附录 A 伪代码 / 附录 B 手算工作簿）
"""
import sys, os, json, math

HERE = os.path.dirname(os.path.abspath(__file__))
# stdout 统一 UTF-8（Node 侧用 utf8 解码；避免 Windows GBK 下中文/³ 报错）
# stdin/stdout 统一 UTF-8（Node 侧按 utf8 编码写入/解码；避免 Windows GBK 下中文/³损坏或报错）
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# ---------------- H49 车辆/物理参数（与设计文档 §5/§9 一致） ----------------
CRR = 0.009        # 滚动阻力系数（重载卡车典型）
CD = 0.35          # 风阻系数（H49 官方）
A = 7.5            # 迎风面积 m²（Class 8 平头牵引车）
RHO0 = 1.225       # 海平面空气密度 kg/m³
G = 9.8066         # 重力加速度
ETA_MT = 0.9       # 电机+传动效率链
DELTA = 1.05       # 旋转质量换算系数
P_FC_MIN = 30.0    # 电堆最低稳定功率 kW（300kW×10%）
P_FC_MAX = 180.0   # 电堆高效区上限 kW（300kW×60%）
ETA_FC = 0.5       # 电堆系统效率（峰值简化；H49 官方 >55%，取 0.5 保守）
LHV = 33.3         # 氢低热值 kWh/kg（120 MJ/kg ÷ 3.6）
P_AUX0 = 3.0       # 附件基础功率 kW（20℃）
K_T = 0.15         # 附件温度系数 kW/℃
P_AUX_MIN, P_AUX_MAX = 2.0, 8.0

# ---------------- 中间变量中文名（前端直接展示用） ----------------
VAR_CN = {
  "v_mps": "车速 m/s",
  "rho": "空气密度 kg/m³",
  "F_roll": "滚动阻力 N",
  "F_aero": "空气阻力 N",
  "F_grade": "坡度阻力 N",
  "F_total": "总驱动力 N",
  "P_wheel": "轮边功率 kW",
  "P_aux": "附件功率 kW",
  "P_drive": "驱动电功率 kW",
  "P_fc": "电堆功率 kW",
  "P_bat": "电池功率 kW",
  "t_h": "行驶时长 h",
  "eta_fc": "电堆效率",
  "E_fc": "电堆电能 kWh",
  "m_H2": "氢耗 kg",
}
VAR_ORDER = ["v_mps", "rho", "F_roll", "F_aero", "F_grade", "F_total",
             "P_wheel", "P_aux", "P_drive", "P_fc", "P_bat", "t_h", "eta_fc", "E_fc", "m_H2"]

def _get(seg, key, default):
    v = seg.get(key)
    return default if v is None else v

def predict_segment(seg):
    """对一段路做物理氢耗计算，返回该段全部中间变量 + 氢耗"""
    L = float(_get(seg, "distanceKm", 5.0))
    v_kmh = float(_get(seg, "avgSpeedKmh", 60.0))
    grade_raw = seg.get("gradePercent")
    grade_missing = grade_raw is None
    grade = float(grade_raw) if not grade_missing else 0.0
    H = float(_get(seg, "elevationM", 100.0))
    T = float(_get(seg, "temperatureC", 20.0))
    m = float(_get(seg, "massKg", 30000.0))          # 前端已算：整备 9700 + 载重×1000
    # 风：windSpeedKmh 是风速标量(≥0)，方向在 windDirDeg（来向，北=0 顺时针）；
    # 逆风分量 = 风速×cos(风来向 − 车头航向)，顺风为负。缺方向/未达阈值(windAffects=false)则不计风阻，
    # 避免把标量风速当成纯逆风而系统性高估。
    w_kmh = float(_get(seg, "windSpeedKmh", 0.0))
    wind_affects = bool(seg.get("windAffects", False))
    wind_dir = seg.get("windDirDeg")
    heading = seg.get("headingDeg")

    # ---- L2 阻力 ----
    v_mps = v_kmh / 3.6
    if wind_affects and w_kmh > 0 and wind_dir is not None and heading is not None:
        head_wind_mps = (w_kmh / 3.6) * math.cos(math.radians(float(wind_dir) - float(heading)))
    else:
        head_wind_mps = 0.0
    v_eff = v_mps + head_wind_mps                     # 等效空气相对速度（逆风为正，顺风为负）
    rho = RHO0 * (1 - 2.25577e-5 * H) ** 4.25588     # 海拔空气密度
    F_roll = CRR * m * G
    F_aero = 0.5 * rho * CD * A * v_eff * abs(v_eff)  # 风阻：逆风增阻，顺风减阻（保号）
    theta = math.atan(grade / 100.0)                  # 坡度 %
    F_grade = m * G * math.sin(theta)                 # 上坡正 / 下坡负
    F_acc = 0.0                                       # 匀速巡航 a=0（接口预留）
    F_total = F_roll + F_aero + F_grade + F_acc

    # ---- L3 动力总成 ----
    P_wheel = F_total * v_mps / 1000.0                # kW（负=下坡回收）
    P_aux = max(P_AUX_MIN, min(P_AUX_MAX, P_AUX0 + K_T * abs(T - 20.0)))
    P_drive = P_wheel / ETA_MT + P_aux

    if P_drive >= P_FC_MIN:
        P_fc = min(P_FC_MAX, P_drive)                 # 正常驱动：电堆供电，超出高效区由电池补
        P_bat = P_drive - P_fc
    elif P_drive > 0:
        P_fc = P_drive                                # 低功率驱动：电堆跟随，不强拉到最低稳定线
        P_bat = 0.0
    else:
        P_fc = 0.0                                    # 下坡/减速再生：电堆关闭，不消耗氢气
        P_bat = max(P_drive, -P_FC_MAX)               # 再生回收，电池充电功率受限

    # ---- L4/L5 效率与氢耗 ----
    t_h = L / v_kmh if v_kmh > 0 else 0.0             # 小时
    eta_fc = ETA_FC                                    # 简化（可扩展极化曲线/温度修正）
    E_fc = P_fc * t_h                                 # kWh
    m_H2 = (E_fc / (eta_fc * LHV)) if eta_fc > 0 else 0.0

    return {
      "index": seg.get("index", 0),
      "roadName": seg.get("roadName", ""),
      "distanceKm": round(L, 2),
      "avgSpeedKmh": round(v_kmh, 1),
      "gradePercent": round(grade, 2),
      "elevationM": round(H, 0),
      "temperatureC": round(T, 1),
      "roadLevel": seg.get("roadLevel") or "other",
      "massKg": round(m, 0),
      # 中间变量
      "v_mps": round(v_mps, 2),
      "rho": round(rho, 4),
      "F_roll": round(F_roll, 0),
      "F_aero": round(F_aero, 0),
      "F_grade": round(F_grade, 0),
      "F_total": round(F_total, 0),
      "P_wheel": round(P_wheel, 1),
      "P_aux": round(P_aux, 2),
      "P_drive": round(P_drive, 1),
      "P_fc": round(P_fc, 1),
      "P_bat": round(P_bat, 1),
      "t_h": round(t_h, 4),
      "eta_fc": round(eta_fc, 3),
      "E_fc": round(E_fc, 2),
      "m_H2": round(m_H2, 4),
      # 结果（与 ML 输出同字段，方便前端复用）
      "h2_per_km_kg": round(m_H2 / L, 4) if L > 0 else 0,
      "h2_per_100km_kg": round(m_H2 / L * 100.0, 2) if L > 0 else 0,
      "h2_kg": round(m_H2, 3),
      "grade_missing": grade_missing,
    }

def main():
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw or "{}")
    except Exception as e:
        print(json.dumps({"ok": False, "msg": "JSON 解析失败: " + str(e)}, ensure_ascii=False)); return
    segs = payload.get("segments") or []
    out = [predict_segment(s) for s in segs]
    total_kg = sum(s["h2_kg"] for s in out)
    total_km = sum(s["distanceKm"] for s in out)
    print(json.dumps({
        "ok": True,
        "total_h2_kg": round(total_kg, 3),
        "per100km_kg": round(total_kg / (total_km / 100.0), 2) if total_km > 0 else 0,
        "var_cn": VAR_CN,
        "var_order": VAR_ORDER,
        "segments": out,
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
