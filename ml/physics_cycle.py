# -*- coding: utf-8 -*-
"""驱动循环物理仿真：v(t)/坡度(t) 序列 → 段级 Z 物理量
标定（用官方换算后的实车数据）：
- 热模型: T_stack = 0.0627·P_fc + 59.8  (R²=0.917, 实车标定)
- 附件:   P_aux = 0.019·P_fc + 0.148·(T-20) + 4.65  (实车标定)
- 母线:   V_bus = 450V (V_FC 实车中位)
- 能量管理(简化): P_fc = 低通滤波(P_drive_total) 夹 [P_FC_MIN,P_FC_MAX]; P_bat = P_drive_total - P_fc
- SOC: SOC_k+1 = SOC_k - P_bat·dt/E_bat (clamp 0~100)
训练/校准阶段用实车 v_series，预测阶段用工况合成 v_series（口径一致）。
"""
import numpy as np

G = 9.8066; CRR = 0.009; CD = 0.35; A = 7.5; ETA_MT = 0.9
P_FC_MIN = 30.0; P_FC_MAX = 180.0; E_BAT_KWH = 75.0
CALIB = {
    'thermal': {'a': 0.0627, 'c': 59.8},        # T_stack = a·P_fc + c
    'aux': {'a': 0.019, 'b': 0.148, 'c': 4.65}, # P_aux = a·P_fc + b·(T-20) + c
    'vbus': 450.0,
}

def cycle_z(v_kmh, grade_pct, temp_c, mass_kg=30000.0, dt=60.0, soc0=62.5, calib=None):
    calib = calib or CALIB
    th = calib['thermal']; aux = calib['aux']; vbus = calib['vbus']
    v = np.asarray(v_kmh, float) / 3.6
    g = np.asarray(grade_pct, float) / 100.0
    n = len(v)
    if n == 0: return None
    T = float(np.mean(temp_c)) if not np.isscalar(temp_c) else float(temp_c)
    a = np.diff(v, prepend=v[0]) / dt
    theta = np.arctan(g)
    F_roll = CRR * mass_kg * G * np.cos(theta)
    F_aero = 0.5 * 1.225 * CD * A * v * v
    F_grade = mass_kg * G * np.sin(theta)
    F_acc = mass_kg * a
    F_total = F_roll + F_aero + F_grade + F_acc
    P_wheel = F_total * v / 1000.0
    P_drive = np.where(P_wheel >= 0, P_wheel / ETA_MT, P_wheel * ETA_MT)
    P_aux = np.clip(aux['a'] * np.maximum(P_drive, 0) + aux['b'] * (T - 20.0) + aux['c'], 0, None)
    P_drive_total = P_drive + P_aux
    k = max(2, int(round(2.0 / dt)) + 1)
    kern = np.ones(k) / k
    P_fc = np.convolve(P_drive_total, kern, mode='same')
    P_fc = np.clip(P_fc, P_FC_MIN, P_FC_MAX)
    P_bat = np.clip(P_drive_total - P_fc, -150.0, 150.0)
    soc = np.full(n, soc0)
    for i in range(1, n):
        soc[i] = min(100.0, max(0.0, soc[i-1] - P_bat[i] * (dt/3600.0) / E_BAT_KWH * 100.0))
    P_fc_mean = float(np.mean(P_fc))
    return {
        'v_kmh': float(np.mean(v_kmh)), 'acc_mps2': float(np.mean(a)),
        'I_FC_A': P_fc_mean * 1000.0 / vbus, 'V_FC': vbus, 'P_FC_kW': P_fc_mean,
        'P_mot_kW': float(np.mean(P_drive)), 'P_aux_kW': float(np.mean(P_aux)),
        'P_batt_kW': float(np.mean(P_bat)), 'P_veh_kW': float(np.mean(P_drive_total)),
        'SOC': float(np.mean(soc)), 'T_stack_C': th['a'] * P_fc_mean + th['c'],
        'T_bottle_C': T,
    }
