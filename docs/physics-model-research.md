# 物理氢耗模型 · 文献调研与建模方案（项目核心模块）

> 日期：2026-08-17 · 项目：hydrogen-newline-predictor（T05 命题二：新线路氢耗预测工具）
> 目的：在动手实现前，依据**可查证的行业文献 / 国家标准 / 开源项目 / 官方实车数据**，确定"足够仿真、
> 可对标、可验证"的氢耗建模方案，作为后续 `PhysicsEngine` 实现的蓝本，并对接企业 MATLAB 模型（可插拔）。
> 说明：本版为**复核强化版**——所有关键数据点均已逐一联网核实并补充出处/DOI/链接；无法核实的引用已标注。

---

## 1. 结论摘要（TL;DR）

1. **建模档次**：采用**准静态（quasi-static）整车能耗模型**（与 NREL FASTSim 同级，L2），
   不做秒级瞬态（电堆动态响应/热管理/MPC 能量管理超出 L2 范围）。
   理由：秒级响应（NFR-1 ≤2s）、精度业界验证 **±10% 内、常 ±5% 内**（NREL，见 §7）、
   可纯前端运行、可与企业 MATLAB 模型按"输入契约"对接（L3 升级路径已预留）。
2. **校准锚点（已升级为三重锚点，全部可查证）**：
   - 锚点 A｜海珀特官方发布指标：H49 满载 49t 高速工况百公里氢耗 **≤8 kg**（2023-12 全球首发，北极星氢能网/21 经济）
   - 锚点 B｜海珀特交付口径：**7.8 kg/100km**、续航 1000km（2024-08 武汉晚报；湖北日报小批量交付报道）
   - 锚点 C｜海珀特 H49 2.0 官方实车验证：满载 49t、均速 75km/h、**≤7.1 kg/100km**，
     已完成**青岛—天津、武汉—宜昌**等平原高速线路实车验证（2025-11 北京氢能创新中心成果发布；2026-06 CEO 孙营访谈）
   → 金样 B（济青 340km 高速、载重 34.11t、7.8 kg/100km）落在 [7.1, 8.0] 官方区间内，**三重锚点互相印证**。
3. **行业对标（已核实）**：潍柴 49t 运营氢耗 8.81 kg/100km（潍柴官网 2025-01）；行业平头氢重卡普遍
   12~14 kg/100km（盖世汽车）；奔驰 GenH2 客户实测 5.6~8 kg/100km（GCW 16~34t、液氢，2025-09）；
   MAN 350kW 氢重卡 7~8 kg/100km（Bayernflotte 项目）；REFIRE 实车 6.9 kg/100km。
   → H49 的 7.1~8 kg/100km 处于全球第一梯队，作为校准锚点可信度高。
4. **开源对标**：NREL **FASTSim**（准静态整车仿真，支持燃料电池车，Python/Excel，SAE 2015-01-0973）——
   架构对标；**OPEM / RCAIDE Larminie-Model**（开源 PEM 极化曲线实现）——效率曲线生成对标；
   EPA **GEM** / 欧盟 **VECTO**（重型车认证仿真工具）——阻力系数与验证方法参考。
5. **中国标准**：**GB/T 38146.2-2019**（CHTC-TT 半挂牵引车工况，工况合成基准，参数已核实）；
   **GB/T 27840-2021**（重型商用车辆燃料消耗量测量方法，附录 C 阻力测定、附录 E 阻力系数推荐方案，已核实）。
6. **建模主线**（与需求文档 §5 一致）：工况合成 → 纵向动力学四阻力（含海拔修正/旋转质量/再生制动）→
   动力总成效率（传动×电机+电池削峰）→ 辅助功耗 → 燃料电池系统效率（Larminie-Dicks）→
   氢耗（LHV，法拉第定律交叉验证）→ 三重锚点校准。

---

## 2. 建模方法选型（为什么是准静态）

| 档次 | 代表 | 时间粒度 | 精度 | 计算量 | 适用性 |
| --- | --- | --- | --- | --- | --- |
| L1 静态平均 | 写死 7.8kg/100km（旧项目） | 全程 | 无法外推 | 忽略 | ❌ 不符合命题要求 |
| **L2 准静态** | **FASTSim / ADVISOR / Guzzella** | **1s 或分段** | **±10% 内（常 ±5%）** | **毫秒~秒级** | ✅ 新线路外推、秒级重算 |
| L3 瞬态/一维 | AVL CRUISE M / 企业 MATLAB | ms | 1~5% | 分钟~小时 | ❌ 浏览器前端跑不动，超 NFR-1 |

- **FASTSim 精度（官方核实）**：NREL 报告（对应 SAE 2022-01-0556）明确"FASTSim 对燃油经济性、
  电耗与加速性能的基型计算结果**通常在实测/标称值 ±10% 以内，且经常在 ±5% 以内**"。
- **行业文献（已核实）**：电动公交在线能耗预测平均 MAPE 7.05%、最低 4.31%
  （Pan et al., Energy, 2023, DOI 10.1016/j.energy.2023.130205）；准静态工具机械量 <5%、电气量 <10%（文献 [12]）。
- 结论：**L2 准静态 + 分段工况合成**是"足够仿真"且"可交付"的最优平衡点；企业 MATLAB 高保真模型
  通过 adapter 接入后自动升级到 L3 保真度（见 §8）。

---

## 3. 推荐模型架构（数据流）

```
[输入] SegmentData[]（里程/均速/坡度/海拔/路况/停车密度/温度，A1+A2 已就绪）
   │
   ▼ ① 工况合成：每段 → (速度 v_k, 坡度 grade_k, 里程, 怠速占比) 代表工况（参考 CHTC-TT 统计特征）
   │
   ▼ ② 纵向动力学：F = F_roll + F_aero + F_grade + F_acc → P_wheel = F·v
   │      （GB/T 27840-2021 附录E 阻力系数；Gillespie / 余志生 四阻力模型；δ 旋转质量；下坡再生制动）
   │
   ▼ ③ 动力总成：P_drive = P_wheel/(η_dt·η_m) + P_aux；电池削峰：P_fc = clamp(P_drive, P_min, P_max)
   │
   ▼ ④ 燃料电池效率：η_fc(P) 效率曲线（Larminie-Dicks 极化曲线 → 电压效率 → 系统效率）
   │
   ▼ ⑤ 氢耗：m_H2,k = P_fc,k × t_k / η_fc(P) / LHV_H2（LHV=33.33 kWh/kg；法拉第定律交叉验证）
   │
   ▼ ⑥ 三重锚点校准：k_cal = 锚点氢耗 / 模型初算氢耗（锚点 A/B/C 加权或取中值）
   │
   ▼ ⑦ 成本引擎：氢耗×氢价 + 路桥 + 人工 + 维保；柴油对比（沿用需求文档 §5.6）
```

---

## 4. 分步建模公式（均带出处）

### 4.1 工况合成（Driving Cycle Synthesis）
- **标准基准（参数已核实，dieselnet CHTC 数据表）**：GB/T 38146.2-2019 中 CHTC-TT（半挂牵引车工况）：
  时长 **1800 s**、里程 **23.29 km**、最高车速 **88.0 km/h**、平均车速（含停）**46.58 km/h**、
  平均行驶车速（不含停）50.97 km/h、加速占比 **16.78%**、减速 16.00%、巡航 **58.61%**、怠速 **8.61%**。
- 做法（分段合成）：每段给巡航速度 `v_k`（高速 80 / 国道 55 / 省道 50 / 城市 30 km/h，可按实时路况系数修正）；
  由 `stopDensity`（停车密度）折算怠速/起停占比；坡度直接取 SegmentData.gradePercent。
  合成时用 CHTC-TT 的巡航/怠速/加减速占比作为参数约束——相当于把标准工况"拉伸"到目标线路的里程/坡度/路况上。
- **新线路无法做实测工况**，这是准静态模型外推精度的天花板；因此引入"坡度约束工况合成"文献作为方法论支撑：
  - Li D. et al., *Accurate energy assessment for cleaner heavy-duty transport: Driving cycle synthesis with
    steady–transient constraints and a dual-mode adaptive genetic algorithm*, **Journal of Cleaner Production**, Vol. 571, 2026
    （明确将道路坡度耦合进能耗代表工况合成，ScienceDirect PII S0959652626013892）
  - Li D., Song H. et al., *Construction of slope-included energy consumption-representative driving cycle for
    heavy-duty commercial vehicles using multi-dimensional index parameter selection and adaptive crayfish-genetic algorithm*,
    **Energy Conversion and Management**, Vol. 356, 2026（含坡度重卡代表工况构建）

### 4.2 行驶阻力（纵向动力学四阻力 + 修正项）
```
F_roll  = Crr × m × g                          （滚动阻力）
F_aero  = 0.5 × ρ(H) × Cd × A × v²             （空气阻力，ρ 随海拔修正）
F_grade = m × g × sin(θ),  θ = atan(grade/100) （坡度阻力，A2 坡度输入）
F_acc   = δ × m × a_eq                          （加速阻力，δ≈1.05 旋转质量换算系数）
F_wheel = F_roll + F_aero + F_grade + F_acc
P_wheel = F_wheel × v
```
- 出处：Gillespie《Fundamentals of Vehicle Dynamics》(SAE, 1992)；余志生《汽车理论》（机械工业出版社）；
  **GB/T 27840-2021 附录 E**（重型商用车行驶阻力系数推荐方案，牵引车有专属公式，可替代滑行试验法，已核实）；
  附录 C（行驶阻力测定及在底盘测功机上的模拟）。**阻力系数优先采用附录 E 推荐公式，缺失参数回退典型值。**
- **海拔修正空气密度**（本项目相对 FASTSim 默认工况的改进点）：
  `ρ(H) = 1.225 × (1 − 2.25577e-5 × H)^4.25588`（国际标准大气模型，H 为平均海拔 m，A2 已填充 elevationM）。
  乌兰察布 1372m → 天津 5m 差约 **15% 空气密度**，直接修正更贴近实际。
- **再生制动**（FCEV 有动力电池，可回收）：下坡/减速段按回收效率 `η_regen ≈ 0.6~0.7` 折算负功回收；
  长下坡段若回收功率超电池限值则余量由机械制动耗散（准静态简化，不建电池 SOC 模型）。

### 4.3 动力总成（传动 × 电机 + 电池削峰）
```
P_drive = P_wheel / (η_dt × η_m(P_load)) + P_aux
P_fc = clamp(P_drive, P_fc_min, P_fc_max)   （电池削峰：高功率尖峰由电池承担，电堆工作在高效区）
```
- `η_dt`：传动效率 ≈0.92（含 AMT 变速箱/后桥，文献典型值 [2][3]）。
- `η_m(P_load)`：电机效率按负载率查表（永磁同步典型：轻载 0.88 / 中载 0.93 / 重载 0.90）。
- 能量管理策略依据（已核实）：
  - 张瑞亮等，*基于低通滤波的大功率型氢燃料电池重型货车自适应能量管理策略*，**汽车工程** 2021, 43(11),
    DOI 10.19562/j.chinasae.qcge.2021.11.015（低通滤波 + 逻辑规则分配功率）
  - *Energy management strategy with model prediction for fuel cell hybrid trucks considering vehicle mass and road slope*,
    **Energy Conversion and Management**, 2025, DOI 10.1016/j.enconman.2025.119791（重庆大学：坡度/质量对 FCHT 能耗的关键性）
  - Geng C. et al., *Simulation and experimental research on energy management control strategy for fuel cell
    heavy-duty truck*, **Int. J. Hydrogen Energy**, 2024（三一 49t FCHT，122 km 实车验证）
  - 升级方向：等效消耗最小化（ECMS）/ 模型预测（MPC）——预留为 L3 或后续版本。

### 4.4 燃料电池系统效率（核心）
- **底层**：Larminie-Dicks 静态极化曲线
  `V_cell = E_oc − A·ln(i) − R·i − m·exp(n·i)`
  （来源：Larminie & Dicks《Fuel Cell Systems Explained》Wiley 2nd ed., 2003；开源实现 OPEM(ECSIM) 与
  RCAIDE Larminie-Model 均采用此式，已核实）。
- **电压效率（LHV 基准）**：`η_stack = V_cell / 1.253`（1.253 V = ΔH_LHV/(2F) = 241.8 kJ/mol/(2×96485 C/mol)，
  氢燃料电池 LHV 当量电压；HHV 对应 1.48 V）。
- **系统效率**：`η_fc = η_stack × η_BOP`（BOP 含空压机/水泵/散热，约 0.85~0.9；海拔高时空压机负载上升，
  按 ρ(H) 比例微调 BOP 损耗）。现代 PEM 系统峰值系统效率（LHV）约 **0.50~0.60**。
- **实现建议**：先用"效率-负载率表"（0.38@10% → 0.55 峰值 → 0.45@100%，与需求文档 §5.5 一致），
  再用 Larminie-Dicks 极化曲线参数做二次校准；两条路都可与 OPEM/FASTSim 输出交叉验证。

### 4.5 氢耗折算（双口径交叉验证）
```
口径A（LHV 效率法）：m_H2,k = (P_fc,k × t_k) / η_fc(P_fc,k) / LHV_H2,   LHV_H2 = 120 MJ/kg = 33.33 kWh/kg
口径B（法拉第定律）：ṁ_H2 = M_H2 × N_cell × I_stack / (2·F),   I_stack = P_fc/(N_cell·V_cell)
```
- 出处：Larminie & Dicks [5]；重卡 PEMFC 整车模型文献 [9]（氢流率按法拉第定律 + 化学计量比）。
- 两口径在实现时互算校验，差异应 <3%（当效率曲线与极化曲线自洽时）。

### 4.6 辅助功耗（出处已更新为权威来源）
- **NRC《21st Century Truck Partnership》(2008)**：干线卡车典型附件负荷 **3~5 kW**（TIAX 2009 亦给出 4 kW 口径）。
- 热管理研究（DiVA 2021，重型电动物流车）：极寒（< −20℃）时座舱+电池热管理可达 **10 kW**。
- 本项目：`P_aux = 3 kW（20℃）+ 每偏离 1℃ ×0.15 kW，上下限 2~8 kW`（沿用需求文档 §5.4；
  温度字段 temperatureC 为 A3 预留，当前按 20℃ 或用户输入）。

### 4.7 三重锚点校准
| 锚点 | 数值 | 工况 | 来源（已核实） |
| --- | --- | --- | --- |
| A 官方发布 | ≤8 kg/100km | 满载 49t、高速 | 2023-12 全球首发（北极星氢能网/21 经济报道） |
| B 交付口径 | 7.8 kg/100km | 满载 49t、高速、续航 1000km | 2024-08 武汉晚报；湖北日报小批量交付 |
| C 实车验证 | ≤7.1 kg/100km | 满载 49t、均速 75km/h、青岛—天津等 | 2025-11 北京氢能创新中心；2026-06 CEO 孙营访谈 |
- 金样 B：H49 × 济青 340km 高速 × 载重 34.11t × 氢价 30 → 氢耗 26.52 kg/趟（=7.8 kg/100km）
  → 单趟氢 1796 / 柴油 1925.2 / 节省 129.2（以金样原值为准，P5 复现断言）。
- 做法：`k_cal = 锚点氢耗 / 模型初算氢耗`（锚点 A/B/C 加权或取中值），后续预测乘以 k_cal；
  可开关——评审可看"纯物理值"与"校准值"两组结果。

---

## 5. 参数清单与来源（实现时集中配置，可校准）

| 参数 | 默认值 | 来源（已核实） |
| --- | --- | --- |
| GVW / 整备质量 | 49 t / **<9 t（发布口径）、<10 t（2.0 口径）** | 海珀特官方（2023-12 发布 / 2025-12 百科） |
| 额定载重 | 49 − 整备 ≈ 39~40 t；**金样 B 运营载重 34.11 t** | 官方 + 金样 |
| 燃料电池系统功率 | 300 kW | 海珀特官方（百度百科/发布报道） |
| 最高车速 | 120 km/h | 官方 |
| Cd | 0.58（平头低风阻，可校） | 重卡带导流罩典型值 [1][3]；GEM Cd 为 OEM 输入；GB/T 27840-2021 附录E 可校 |
| A 迎风面积 | 7.5 m²（平头重卡） | GEM 表：Class 8 组合牵引车 10.4/7.7/6.9 m²；平头取小值 |
| Crr | 0.009（0.006~0.012） | 重载商用典型 [1][3] |
| ρ₀ 空气密度 | 1.225 kg/m³（15℃ 海平面） | 国际标准大气；随海拔修正 |
| δ 旋转质量系数 | 1.05 | 重卡典型（Guzzella [2]） |
| η_dt / η_m | 0.92 / 0.88~0.93 | 行业典型 [2] |
| 电堆效率曲线 | 峰值 ~0.55（LHV 系统） | [5]；OPEM/RCAIDE 极化曲线校准 |
| LHV_H2 | 120 MJ/kg = 33.33 kWh/kg | [5] |
| P_aux | 3 kW（2~8 随温度） | NRC 21st Century Truck Partnership [15] |
| 巡航速度 | 高速 80 / 国道 55 / 省道 50 / 城市 30 km/h | 行业常用 + CHTC-TT 平均速度约束 |
| 目标锚点 | 7.1 / 7.8 / ≤8 kg/100km | 锚点 A/B/C（见 §4.7） |

---

## 6. 开源对标（实现期用）

1. **NREL FASTSim**（Python，`pip install fastsim`，GitHub: NatLabRockies/fastsim；SAE 2015-01-0973）：
   用 H49 参数 + CHTC-TT 工况跑一遍，与我们的模型输出对比（百公里氢耗量级、坡度敏感性）。
2. **OPEM**（GitHub: ECSIM/opem，MIT）与 **RCAIDE Larminie-Model**：生成 Larminie-Dicks 极化曲线 → 效率曲线，
   标定我们的 η_fc 表（RCAIDE 文档已给出 V = E0 − A·ln(j) − R·j − m·exp(n·j) 实现）。
3. **EPA GEM** 与欧盟 **VECTO**：重型车认证用仿真工具，其阻力系数/附件负荷/验证方法论可作为参数与流程参考。
4. **ADVISOR**（NREL 经典，架构参考）：后向/前向能耗仿真流程。

---

## 7. 精度、验证与误差来源

- **精度预期（文献支撑）**：准静态分段模型对整段能耗 **±10% 内、常 ±5% 内**（NREL FASTSim 官方口径，
  SAE 2022-01-0556 对应报告）；电动公交能耗预测 MAPE 平均 7.05%、最低 4.31%（Energy 2023, DOI 10.1016/j.energy.2023.130205）。
- **验证路径（P5，写进 verify:model）**：
  1. **金样 B 复现**（1796/1925.2/129.2，氢耗 26.52 kg/趟）——硬性验收；
  2. **三重锚点核对**：7.1 / 7.8 / 8.0 kg/100km 区间内；
  3. 与 FASTSim 同参数对照（如可安装）；
  4. **敏感性分析**：坡度 / 载重 / 速度 / 温度 / 路况 ±10% → tornado 图；
  5. **不确定度输出**：预测值给出 ±10% 区间，评审可解释"物理模型+校准"的双层结构。
- **误差来源排序（预期）**：坡度 > 载重 > 合成工况 vs 实际驾驶 > 辅助功耗 > 路况 > 海拔空气密度。
  其中坡度误差已通过 A2 细分（坡度变号切段）显著降低；工况合成误差是准静态模型的天花板，
  通过"分段巡航 + 怠速占比"近似控制，并在报告中声明（诚实披露 = 加分项）。

---

## 8. 可插拔架构（对接企业 MATLAB 模型）

```
interface H2ConsumptionEngine {
  calc(segments: SegmentData[], vehicle: VehicleParams, ops: OpsParams): ConsumptionResult
}
PhysicsEngine   // 本仓库实现（准静态四阻力 + 效率曲线 + 三重锚点校准）
HypertEngine    // 企业模型 adapter：只做 SegmentData → MATLAB 内部变量映射
```
- 企业模型接入只写字段映射（roadLevel → road_class、gradePercent → grade_pct 等），模型本体不动；
- 一个配置开关切换引擎；前端/成本引擎只依赖 `ConsumptionResult`（氢耗 kg、百公里氢耗、分项能量）。
- **L3 升级路径**（评审答辩可讲）：接入企业 MATLAB 后，可升级 1Hz 瞬态工况、热管理、ECMS/MPC 能量管理，
  模型精度从 ±10% 提升到 1~5%，且输入契约（SegmentData）不变。

---

## 9. 参考文献（已逐条核实）

### 英文
1. Gillespie, T. D. *Fundamentals of Vehicle Dynamics*. SAE International, 1992.（四阻力模型）
2. Guzzella, L., Sciarretta, A. *Vehicle Propulsion Systems*. Springer, 3rd ed., 2013.（准静态整车建模；旋转质量系数）
3. 余志生. 《汽车理论》（第 6 版）. 机械工业出版社.（行驶阻力四力模型）
4. SAE 2023-01-0473, *Multi-Objective Optimization of the Fuel Cell Hybrid Electric Powertrain for a Class 8
   Heavy-Duty Truck*（AVL CRUISE M，DAF 44t 满载，氢耗 12.46 kg/100km）—— 已核实 SAE Mobilus 摘要
5. Larminie, J., Dicks, A. *Fuel Cell Systems Explained*. Wiley, 2nd ed., 2003.（LHV=120 MJ/kg、极化曲线、效率与 1.253 V 当量电压）
6. NREL. *FASTSim: A Model to Estimate Vehicle Efficiency, Cost and Performance*. SAE 2015-01-0973
   （https://www.nrel.gov/transportation/fastsim.html；含燃料电池车；Python/Excel 免费）
7. Li D., Su Z., Yang M., Bi D., Zhang Y. *Accurate energy assessment for cleaner heavy-duty transport: Driving cycle
   synthesis with steady–transient constraints and a dual-mode adaptive genetic algorithm*. **Journal of Cleaner
   Production**, Vol. 571, 2026.（PII S0959652626013892；含坡度耦合工况合成）
8. Li D., Song H., Yang M., Guo L., Qu D. *Construction of slope-included energy consumption-representative driving cycle
   for heavy-duty commercial vehicles using multi-dimensional index parameter selection and adaptive crayfish-genetic
   algorithm*. **Energy Conversion and Management**, Vol. 356, 2026.（含坡度重卡代表工况）
9. *Verified PEMFC heavy-duty long-haul truck vehicle model with thermal management limitations*. **Applied Thermal
   Engineering**, 2025.（高保真整车模型，法拉第氢流率）—— [待核：卷期页码，实现前补全]
10. *Predicting Energy Consumption for Heavy-Duty Vehicles: With an Emphasis on Auxiliary Consumption*（Högskolan i
    Halmstad 硕士论文，与 Volvo Trucks 合作，2025，diva2:1930565）—— 已核实
11. Pan Y., Fang W., Ge Z., Li C., Wang C., Guo B. *A hybrid on-line approach for predicting the energy consumption of
    electric buses based on vehicle dynamics and system identification*. **Energy**, 2023/2024, DOI
    10.1016/j.energy.2023.130205.（MAPE 平均 7.05%、最低 4.31%）—— 已核实
12. *Longitudinal Dynamics Simulation Tool for Hybrid APU and Full Electric Vehicle*.（准静态工具：机械量 <5%、电气量 <10%）—— [待核：完整出处]
13. *Energy management strategy with model prediction for fuel cell hybrid trucks considering vehicle mass and road
    slope*. **Energy Conversion and Management**, 2025, DOI 10.1016/j.enconman.2025.119791.（重庆大学）—— 已核实
14. Geng C., Mei S., Liu L., Ma W., Xue Q. *Simulation and experimental research on energy management control strategy
    for fuel cell heavy-duty truck*. **Int. J. Hydrogen Energy**, 2024.（三一 49t FCHT，122 km 实车）—— 已核实
15. NRC. *Review of the 21st Century Truck Partnership*. National Academies Press, 2008.（干线卡车附件负荷 3~5 kW）；
    TIAX, 2009（4 kW）；DiVA 2021（HD EV 热管理 <−20℃ 达 10 kW）—— 已核实
16. OPEM (Open Source PEM Fuel Cell Simulation Tool), GitHub: ECSIM/opem, MIT；RCAIDE Larminie-Model
    （V = E0 − A·ln(j) − R·j − m·exp(n·j)）—— 已核实
17. NREL. *FASTSim* 精度口径：SAE 2022-01-0556 对应技术报告（NREL/TP-5400-81097）：
    "typically within 10%, and often within 5%" —— 已核实

### 中文
- 张瑞亮, 陈准, 刘森海, 范政武. 基于低通滤波的大功率型氢燃料电池重型货车自适应能量管理策略. **汽车工程**, 2021, 43(11).
  DOI 10.19562/j.chinasae.qcge.2021.11.015 —— 已核实
- 《基于国六商用车实际运行数据的行驶工况研究》. 2023.（3000 辆半挂牵引车实际数据构建代表工况）—— [待核：完整出处]

### 标准（已核实）
- GB/T 38146.2-2019《中国汽车行驶工况 第 2 部分：重型商用车辆》（2019-10 发布，2020-05 实施；
  CHTC-TT：1800s/23.29km/88km/h/46.58km/h/巡航 58.61%/怠速 8.61%，dieselnet 数据表）
- GB/T 27840-2021《重型商用车辆燃料消耗量测量方法》（附录 C 行驶阻力测定及在底盘测功机上的模拟、
  附录 E 重型商用车辆行驶阻力系数推荐方案，均为规范性附录；模拟计算法路线）

### 数据锚点（官方/行业，已核实）
- **海珀特 H49**：300kW 燃料电池系统、GVW 49t、自重 <9t（发布口径，2023-12）/ <10t（2.0，2025-12）、
  最高车速 120km/h、B10 寿命 >150 万公里；满载 49t 高速百公里氢耗 **≤8 kg**（发布）、**7.8 kg**（交付口径）、
  **≤7.1 kg**（2.0 实车验证，均速 75km/h，青岛—天津/武汉—宜昌，2025-11 北京氢能创新中心；2026-06 CEO 孙营：
  氢价 30 元/kg 时每公里燃料成本约 2.13 元，低于柴油 2.2~2.4 元/公里）
- **潍柴**：49t 重卡运营氢耗 **8.81 kg/100km**；港牵车 8.51 kg/100km（潍柴官网 2025-01）
- **行业均值**：平头氢燃料电池重卡百公里氢耗普遍 **12~14 kg**（盖世汽车 2025-06）
- **奔驰 GenH2**：客户实测（225,000 km、285 次加注、约 15t 液氢）平均 5.6~8 kg/100km（GCW 16~34t，2025-09）
- **MAN**：350kW 氢重卡（Bayernflotte 项目）正常运营 7~8 kg/100km（2026-08）
- **REFIRE**：实车纯氢运行 6.9 kg/100km（2025-12）

---

## 10. 下一步实施计划（供评审/开发对齐）

1. **P0 模型骨架**：`src/model/`——`H2ConsumptionEngine` 接口 + `PhysicsEngine`（纯函数，NFR-3 可测）；
   `VehicleParams` 配置表（H49 / 18t / 4.5t 三款）。
2. **P1 四阻力 + 工况合成**：分段 (v, grade, stopDensity) → P_wheel；海拔修正 ρ；δ 旋转质量；再生制动。
3. **P2 效率曲线**：Larminie-Dicks 生成 η_fc(P) 表（OPEM/RCAIDE 交叉验证）+ 电机/传动效率；辅助功耗。
4. **P3 氢耗 + 校准**：LHV 折算（法拉第交叉验证）；三重锚点（7.1/7.8/8.0）k_cal。
5. **P4 前端集成**：选车型/载重/氢价 → 秒级重算 → KPI + 费用构成 + 柴油对比 + 敏感性 tornado。
6. **P5 对标验证**：`npm run verify:model`——金样复现断言 + 三重锚点区间断言 + FASTSim 对照（如可安装）。

---

*复核记录：2026-08-17 逐一联网核实锚点（海珀特 7.1/7.8/8.0）、行业实测（潍柴/奔驰/MAN/REFIRE）、
CHTC-TT 参数、GB/T 27840 附录、FASTSim 精度、关键论文 DOI 与出处；[待核] 项在实现 P1/P2 前补全。*
