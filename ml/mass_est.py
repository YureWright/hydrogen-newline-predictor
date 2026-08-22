# -*- coding: utf-8 -*-
"""行程级能量平衡质量反推（Energy-Balance Mass Estimation）

原理：对整趟行程做能量守恒——电机输出的驱动电能 = 克服四阻力的功。
空调等附件不经过驱动电机（并联支路），天然不进方程；电机电能实测（三电机 V×I，
官方换算：电流 offset −1000A、电压 ×0.1）。

    E_drive = m·g·Σ(sinθ + Crr·cosθ)·v·Δt + Σ ½ρCdA v³·Δt
    ⇒ m = (E_drive − E_aero) / [g·Σ(sinθ + Crr·cosθ)·v·Δt]

动能项 Σma·v·Δt = ½m(v_end²−v_start²) ≈ 0（起终点速度相同，闭合行程消去）。
只在驱动点（P_elec>5kW）积分；随机噪声被整行程积分平均掉（大数定律），
剩余系统偏差（η/Crr/CdA 假设 + CAN 换算）用官方锚点校准。

参考：docs/WORKLOG.md 2026-08-22「行程级质量反推」。
"""
import os, json, sys
import pandas as pd, numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_JSON = os.path.join(HERE, "mass_est.json")

# ---------- 车辆/物理参数 ----------
ETA = 0.90      # 电机+传动效率链（假设，锚点校准吸收偏差）
CRR = 0.009     # 滚动阻力系数（重载卡车典型）
CD = 0.35       # 风阻系数（H49 官方）
A = 7.5         # 迎风面积 m²（Class 8 平头牵引车典型）
RHO = 1.225     # 空气密度 kg/m³
G = 9.8066

MASS_FLOOR = 6000.0     # 物理下限：空车自重 <10t，留余量
MASS_CEIL = 65000.0     # 物理上限：满载 49t + 反推系统偏差余量
MIN_TRIP_POINTS = 30    # 行程最少点数
MIN_DRIVE_POINTS = 10   # 行程最少驱动点
MIN_COEF = 2000.0       # 质量系数下限（J/kg）：纯平路短途不稳定
MIN_DIST_KM = 10.0      # 行程最少里程

def load_csv(f):
    for enc in ("utf-8-sig", "utf-8", "gbk"):
        try: return pd.read_csv(f, encoding=enc)
        except Exception: continue
    raise IOError("无法读取: " + f)

def _col(d, c): return pd.to_numeric(d[c], errors="coerce")
def _motor_cur(s): return pd.to_numeric(s, errors="coerce") - 1000.0
def _vol(s): return pd.to_numeric(s, errors="coerce") * 0.1

def motor_power_kw(d):
    """三电机总电功率 kW（正=驱动，负=再生回收）"""
    return (_vol(d["H49Data_mid_bridge_motor_vol_中桥驱动电机控制器电压"])*_motor_cur(d["H49Data_mid_bridge_motor_cur_中桥驱动电机控制器电流"])
          + _vol(d["H49Data_back_bridge_motor_vol_L_后桥左驱动电机控制器电压"])*_motor_cur(d["H49Data_back_bridge_motor_cur_L_后桥左驱动电机控制器电流"])
          + _vol(d["H49Data_back_bridge_motor_vol_R_后桥右驱动电机控制器电压"])*_motor_cur(d["H49Data_back_bridge_motor_cur_R_后桥右驱动电机控制器电流"]))/1000.0

def estimate_trip_mass(d):
    """返回 {trip_id: mass_kg}，只含能稳定解出的行程"""
    P = motor_power_kw(d).values
    t = pd.to_datetime(d.iloc[:, 0], errors="coerce").values
    dt = np.full(len(d), 0.0); dt[1:] = np.diff(t).astype("timedelta64[s]").astype(float)
    trip = (dt > 300).cumsum()
    v = _col(d, "canData_speed_车速").values / 10.0          # km/h
    grade = _col(d, "grade_pct").values
    th = np.radians(np.arctan(np.nan_to_num(grade) / 100.0))
    vms = v / 3.6
    out = {}
    for tr in np.unique(trip):
        idx = np.where(trip == tr)[0]
        if len(idx) < MIN_TRIP_POINTS: continue
        vv = vms[idx]; pp = P[idx]; tt = dt[idx]; gg = th[idx]
        drv = pp > 5.0
        if drv.sum() < MIN_DRIVE_POINTS: continue
        E_drive_J = np.sum(pp[drv] * 1000.0 * ETA * tt[drv])                       # 电机→轮边可用能（J）
        E_aero_J  = np.sum(0.5 * RHO * CD * A * vv[drv] ** 3 * tt[drv])            # 风阻能（J）
        coef = G * np.sum((np.sin(gg[drv]) + CRR * np.cos(gg[drv])) * vv[drv] * tt[drv])  # J/kg
        dist = np.sum(vv * tt) / 1000.0
        if abs(coef) < MIN_COEF or dist < MIN_DIST_KM: continue
        m = (E_drive_J - E_aero_J) / coef
        if MASS_FLOOR < m < MASS_CEIL:
            out[int(tr)] = round(float(m), 1)
    return out

def main():
    jobs = [("V1", os.path.join(ROOT, "_v1_feat.csv"), "车辆1"),
            ("V2", os.path.join(ROOT, "_v2_feat.csv"), "车辆2")]
    result = {}
    for key, path, tag in jobs:
        d = load_csv(path)
        m = estimate_trip_mass(d)
        if m:
            med = float(np.median(list(m.values())))
        else:
            med = 30000.0
        result[key] = {"trips": {str(k): v for k, v in m.items()},
                       "default_mass_kg": round(med, 1),
                       "n_trips_solved": len(m)}
        print("[%s] 解出行程 %d 个 | 质量范围 %.1f~%.1f t | 中位 %.1f t | 缺省 %.1f t" % (
            tag, len(m), min(m.values())/1000 if m else 0, max(m.values())/1000 if m else 0,
            med/1000, med/1000))
    json.dump(result, open(OUT_JSON, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("已保存:", OUT_JSON)

if __name__ == "__main__":
    main()
