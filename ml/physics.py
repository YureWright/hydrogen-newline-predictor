# -*- coding: utf-8 -*-
"""物理氢耗模型引擎（PhysicsEngine）
输入：SegmentData（与 ml/predict.py 同一数据接口）
  {distanceKm, avgSpeedKmh, gradePercent, elevationM, temperatureC,
   windSpeedKmh, windDirDeg, windAffects, headingDeg, humidityPct, roadLevel, massKg, gainM,
   sigmaKmh?（段内速度波动，可选；缺省按道路等级+均速估算，用于 F_aero 的 E[v²] 修正）,
   stopCount?（期望停车次数，缺省 0；>0 时计入启停动能净损耗 + 停车附件耗电）, stopSecondsPer?（单次停车 s，缺省 30）, etaRegen?（再生回收比例，缺省 0.30）,
   车辆参数 override（可选，前端车型预设）: crr, cd, frontArea, eta_mt, p_fc_min, p_fc_max,
                                              p_bat_max, eta_fc, p_aux0, k_t, p_aux_min, p_aux_max}
计算：四阻力（含 cos(θ) 与 σ 修正）→ 总力 → 轮边功率 → 驱动电功率(驱动/再生方向不同)
     → 电堆/电池削峰 → 启停能耗（动能净损耗 + 停车附件）→ 电堆效率 → 氢耗
输出：每段含全部中间变量（英文 key，中文名见 VAR_CN）+ 总计
参考：docs/物理氢耗模型_设计方案.html（§4 四阻力 / §5 动力总成 / 附录 A 伪代码 / 附录 B 手算工作簿）
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
P_BAT_MAX = 150.0  # 电池充/放电功率限幅 kW（75kWh×2C 持续）；超限部分由机械制动耗散
ETA_FC = 0.5       # 电堆系统效率（峰值简化；H49 官方 >55%，取 0.5 保守）
LHV = 33.3         # 氢低热值 kWh/kg（120 MJ/kg ÷ 3.6）
P_AUX0 = 3.0       # 附件基础功率 kW（20℃）
K_T = 0.15         # 附件温度系数 kW/℃
P_AUX_MIN, P_AUX_MAX = 2.0, 8.0

# ---------------- 启停能耗参数（2026-08-23 新增：启停按期望次数计入） ----------------
ETA_REGEN = 0.30          # 再生制动回收比例（重卡城市启停典型：机械制动为主，约回收 30%）
T_STOP_S_DEFAULT = 30.0   # 单次停车时长默认 s（前端按行为类型传 stopSecondsPer 覆盖）

# ---------------- 中间变量中文名（前端直接展示用） ----------------
VAR_CN = {
  "v_mps": "车速 m/s",
  "sigma_kmh": "速度波动 km/h",
  "rho": "空气密度 kg/m³",
  "F_roll": "滚动阻力 N",
  "F_aero": "空气阻力 N",
  "F_grade": "坡度阻力 N",
  "F_acc": "加速阻力 N",
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
  "N_stops": "期望停车次数",
  "t_stop_total_h": "停车总时长 h",
  "E_stop_ke_kwh": "启停动能净损耗 kWh",
  "E_stop_idle_kwh": "停车附件耗电 kWh",
  "E_stop_kwh": "启停附加电能 kWh",
  "m_H2_stop": "启停附加氢耗 kg",
}
VAR_ORDER = ["v_mps", "sigma_kmh", "rho", "F_roll", "F_aero", "F_grade", "F_acc", "F_total",
             "P_wheel", "P_aux", "P_drive", "P_fc", "P_bat", "t_h", "eta_fc", "E_fc", "m_H2",
             "N_stops", "t_stop_total_h", "E_stop_ke_kwh", "E_stop_idle_kwh", "E_stop_kwh", "m_H2_stop"]

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
    # ---- vehicle/physical params (default H49; per-segment override from frontend) ----
    crr       = float(_get(seg, "crr", CRR))
    cd        = float(_get(seg, "cd", CD))
    a_front   = float(_get(seg, "frontArea", A))
    eta_mt    = float(_get(seg, "eta_mt", ETA_MT))
    p_fc_min  = float(_get(seg, "p_fc_min", P_FC_MIN))
    p_fc_max  = float(_get(seg, "p_fc_max", P_FC_MAX))
    p_bat_max = float(_get(seg, "p_bat_max", P_BAT_MAX))
    eta_fc    = float(_get(seg, "eta_fc", ETA_FC))
    p_aux0    = float(_get(seg, "p_aux0", P_AUX0))
    k_t       = float(_get(seg, "k_t", K_T))
    p_aux_min = float(_get(seg, "p_aux_min", P_AUX_MIN))
    p_aux_max = float(_get(seg, "p_aux_max", P_AUX_MAX))
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
    rho = RHO0 * (1 - 2.25577e-5 * H) ** 4.25588      # 海拔空气密度
    # 段内速度波动 σ：设计文档 §B.0b 要求 F_aero 用 E[v²]=v̄²+σ² 修正（起停/波动段风阻会低估）；
    # 前端未采集 σ 时按道路等级+均速经验估算（高速巡航波动小、城市起停波动大）。
    sigma_kmh_raw = seg.get("sigmaKmh")
    if sigma_kmh_raw is None:
        lv_str = str(seg.get("roadLevel") or "other")
        if lv_str in ("highway", "expressway"):
            sigma_kmh = max(2.0, v_kmh * 0.05)         # 巡航 5% 均速（约 3~5 km/h）
        elif lv_str in ("national", "provincial"):
            sigma_kmh = max(3.0, v_kmh * 0.10)         # 稍波动
        else:
            sigma_kmh = max(5.0, v_kmh * 0.20)         # 城市起停：波动大
    else:
        sigma_kmh = float(sigma_kmh_raw)
    sigma_mps = sigma_kmh / 3.6
    theta = math.atan(grade / 100.0)                  # 坡度弧度（grade 为百分比）
    F_roll = crr * m * G * math.cos(theta)            # 设计文档 §4.1：滚阻含 cos(θ)，陡坡时才不高估
    # E[v_eff²] = v_eff·|v_eff| + σ² —— 逆风/顺风保号 + 速度波动修正
    v_eff2 = v_eff * abs(v_eff) + sigma_mps * sigma_mps
    F_aero = 0.5 * rho * cd * a_front * v_eff2
    F_grade = m * G * math.sin(theta)                 # 上坡正 / 下坡负
    F_acc = 0.0                                       # 匀速巡航 a=0（接口预留）
    F_total = F_roll + F_aero + F_grade + F_acc

    # ---- L3 动力总成 ----
    P_wheel = F_total * v_mps / 1000.0                # kW（负=下坡回收）
    P_aux = max(p_aux_min, min(p_aux_max, p_aux0 + k_t * abs(T - 20.0)))
    # 电机方向：驱动时电→机械 (P_wheel=P_elec×η)，再生时机械→电 (P_elec=|P_wheel|×η)；
    # 一律用 /η 会让下坡回收电量虚高 ~20%（能量守恒方向反了）。
    if P_wheel >= 0:
        P_drive = P_wheel / eta_mt + P_aux            # 驱动：需要更多电才能输出这么多机械能
    else:
        P_drive = P_wheel * eta_mt + P_aux            # 再生：机械能转电时链路损耗，回收变少

    if P_drive >= p_fc_min:
        P_fc = min(p_fc_max, P_drive)                 # 正常驱动：电堆供电，超出高效区由电池补
    elif P_drive > 0:
        P_fc = p_fc_min                               # 低速/怠速（0<P_drive<P_fc_min）：电堆最低稳定运行（避免关停-重启损耗），富余充电电池
    else:
        P_fc = p_fc_min                                # 下坡/减速再生：电堆最低稳定运行（附件电由电堆烧氢出，回收电全部充电池）；避免关停-重启损耗，也不会「白拿」回收电
    P_bat = max(-p_bat_max, min(p_bat_max, P_drive - P_fc))   # 电池补差（正=放电，负=充电），受±限幅；超限部分由机械制动耗散

    # ---- L2b 启停能耗（启停按期望次数计入；stopCount=0 时恒为 0，回到纯匀速巡航）----
    N_stops = max(0.0, float(_get(seg, "stopCount", 0.0)))
    N_stops = min(N_stops, L * 10.0)       # 物理约束：不超过 10 次/km（最短停车间距 ~100m）
    t_stop_s = max(0.0, float(_get(seg, "stopSecondsPer", T_STOP_S_DEFAULT)))
    eta_regen = float(_get(seg, "etaRegen", ETA_REGEN))
    # 有效停车速度：城区走走停停时车不会在两个停车点间加速到段平均速度，
    # 用一个更低的有效峰值速度计算动能，避免城区短段氢耗虚高。
    lv_stop_cap = {"city": 30.0, "county": 35.0, "other": 35.0,
                   "provincial": 50.0, "national": 50.0, "expressway": 70.0, "highway": 80.0}
    v_stop_cap_mps = lv_stop_cap.get(lv_str, 40.0) / 3.6
    v_stop_mps = min(v_mps, v_stop_cap_mps)
    ke_j = 0.5 * DELTA * m * v_stop_mps * v_stop_mps              # J
    E_stop_ke_kwh = N_stops * ke_j * (1.0 / eta_mt - eta_regen * eta_mt) / 3.6e6
    P_aux_stop = max(p_aux_min, min(p_aux_max, p_aux0 + k_t * abs(T - 20.0)))
    P_fc_stop = max(p_fc_min, P_aux_stop)
    t_stop_total_h = N_stops * t_stop_s / 3600.0
    # 停车总时长不超过行驶时长（物理约束：停的时间不该比开的时间还长）
    t_drive_h = L / v_kmh if v_kmh > 0 else 0.0
    t_stop_total_h = min(t_stop_total_h, t_drive_h)
    E_stop_idle_kwh = P_fc_stop * t_stop_total_h
    E_stop_kwh = E_stop_ke_kwh + E_stop_idle_kwh
    m_H2_stop = (E_stop_kwh / (eta_fc * LHV)) if eta_fc > 0 else 0.0

    # ---- L4/L5 效率与氢耗 ----
    t_h = L / v_kmh if v_kmh > 0 else 0.0
    E_fc = P_fc * t_h + E_stop_kwh
    m_H2 = (E_fc / (eta_fc * LHV)) if eta_fc > 0 else 0.0
    # 物理上限保护：极端城区最恶劣条件下重卡氢耗率不超过 25 kg/100km（文献上限 ~20，留余量）
    MAX_H2_PER_100KM = 25.0
    max_h2_for_seg = MAX_H2_PER_100KM * L / 100.0
    if L > 0 and m_H2 > max_h2_for_seg:
        m_H2 = max_h2_for_seg

    return {
      "index": seg.get("index", 0),
      "roadName": seg.get("roadName", ""),
      "distanceKm": round(L, 2),
      "avgSpeedKmh": round(v_kmh, 1),
      "gradePercent": round(grade, 2),
      "elevationM": round(H, 0),
      "temperatureC": round(T, 1),
      "humidityPct": seg.get("humidityPct"),
      "roadLevel": seg.get("roadLevel") or "other",
      "massKg": round(m, 0),
      # 风（透传供前端展示）
      "windSpeedKmh": round(float(_get(seg, "windSpeedKmh", 0.0)), 1),
      "windDirDeg": seg.get("windDirDeg"),
      "windDirText": seg.get("windDirText") or "",
      "windAffects": bool(seg.get("windAffects", False)),
      "headingDeg": seg.get("headingDeg"),
      # 中间变量
      "v_mps": round(v_mps, 2),
      "sigma_kmh": round(sigma_kmh, 2),
      "rho": round(rho, 4),
      "F_roll": round(F_roll, 0),
      "F_aero": round(F_aero, 0),
      "F_grade": round(F_grade, 0),
      "F_acc": round(F_acc, 0),
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
      "N_stops": round(N_stops, 2),
      "t_stop_total_h": round(t_stop_total_h, 4),
      "E_stop_ke_kwh": round(E_stop_ke_kwh, 4),
      "E_stop_idle_kwh": round(E_stop_idle_kwh, 4),
      "E_stop_kwh": round(E_stop_kwh, 4),
      "m_H2_stop": round(m_H2_stop, 4),
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
    # echo which vehicle params were actually used (first segment override or defaults)
    def _sp(key, default):
        for s in segs:
            v = s.get(key)
            if v is not None:
                return v
        return default
    vehicle_used = {
        "crr": _sp("crr", CRR), "cd": _sp("cd", CD), "frontArea": _sp("frontArea", A),
        "eta_mt": _sp("eta_mt", ETA_MT), "p_fc_min": _sp("p_fc_min", P_FC_MIN), "p_fc_max": _sp("p_fc_max", P_FC_MAX),
        "p_bat_max": _sp("p_bat_max", P_BAT_MAX), "eta_fc": _sp("eta_fc", ETA_FC),
        "p_aux0": _sp("p_aux0", P_AUX0), "k_t": _sp("k_t", K_T),
    }
    total_kg = sum(s["h2_kg"] for s in out)
    total_km = sum(s["distanceKm"] for s in out)
    print(json.dumps({
        "ok": True,
        "total_h2_kg": round(total_kg, 3),
        "per100km_kg": round(total_kg / (total_km / 100.0), 2) if total_km > 0 else 0,
        "var_cn": VAR_CN,
        "var_order": VAR_ORDER,
        "vehicle": vehicle_used,
        "segments": out,
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
