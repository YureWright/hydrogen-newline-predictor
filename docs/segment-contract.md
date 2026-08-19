# SegmentData 契约 —— 氢耗物理模型的标准输入（A1）

> 里程碑：A1（分段切片 + 输入契约）· A2（DEM 高程/坡度填充）
> 日期：2026-08-17
> 作用：这是"可插拔物理仿真模型"的**字段契约**。我们的模型、企业 MATLAB 模型都只认这一份输入结构。

## 1. 为什么需要这份契约

命题资料说明企业已有 MATLAB 物理仿真模型（线下未对接）。为避免"等模型对接后大改"：

1. 先定义**统一输入结构** `SegmentData`（路段级），任何模型接入时只需写一个 **adapter 做字段映射**，模型本体不动；
2. 我们自己的手搓模型（`PhysicsEngine`）直接消费这份结构；
3. 企业模型对接后写 `HypertEngine`（适配层），一行开关即可切换，符合"可插拔"架构。

命名/单位参考 NREL FASTSim（其 drive cycle 用 `cyc_secs / cyc_mph / cyc_grade`，坡度用百分数），本结构采用公制 + 明确单位。

## 2. SegmentData 字段说明

| 字段 | 类型 | 单位 | 含义 | 来源 | FASTSim 对应 | 当前状态 |
| --- | --- | --- | --- | --- | --- | --- |
| `index` | number | - | 段序号（0 起） | buildSegments | - | ✅ |
| `roadName` | string | - | 道路名（可空） | 高德导航指令提取 | - | ✅ |
| `roadLevel` | enum | - | 高速/国道/省道/城市/其他 | 道路名+收费里程推断 | - | ✅ |
| `distanceKm` | number | km | 本段里程 | 高德 step.distance | cyc_secs×速度 | ✅ |
| `avgSpeedKmh` | number | km/h | 本段平均速度 | step.distance/duration（含实时路况） | cyc_mph | ✅ |
| `gradePercent` | number|null | % | 平均坡度（+上坡/−下坡） | SRTM DEM（A2） | cyc_grade | ⏳ A2 |
| `elevationM` | number|null | m | 平均海拔（修正空气密度 ρ） | SRTM DEM（A2） | - | ⏳ A2 |
| `trafficStatus` | enum | - | 畅通/缓行/拥堵/严重/未知 | tmcs 距离加权主导 | - | ✅ |
| `stopDensity` | number | 次/km | 背景停车/怠速密度（仅当段内无任何停车事件时才用） | 道路等级×路况系数推断 | - | ✅ |

> ⚠️ **`gradePercent = null` 表示"这段没取到高程"，不是"平路"。** 消费方必须显式处理：跳过该段、用邻段插值、或标记结果不确定；直接 `?? 0` 会把坡度阻力算没，山区线路氢耗会被系统性低估。`elevationM` 与 `profile.elevM` 中的 `null` 同理。
| `motionBehavior` | enum | - | 变速行为：巡航/收费站/路口/匝道/转弯/服务区/城市起停 | 高德指令关键词+航向角（L1） | - | ✅ |
| `motionEvents` | MotionEvent[] | - | 变速事件（stop/start/decel/turn + 概率 + 期望次数） | 同 L1 | - | ✅ |
| `temperatureC` | number|null | ℃ | 气温（影响辅助功耗/电堆效率） | 高德天气/区间插值（A3） | - | ⏳ A3 |
| `coordsWgs84` | [lng,lat][] | ° | 本段坐标序列（WGS-84） | 高德 GCJ-02 逆转换 | - | ✅ |
| `durationH` | number | h | 本段时长（distance/avgSpeed） | step.duration | cyc_secs | ✅ |

### 枚举值

`RoadLevel`: `highway`（高速）| `national`（国道）| `provincial`（省道）| `city`（城市/快速路）| `other`（其他）

`TrafficStatus`: `smooth`（畅通）| `slow`（缓行）| `congested`（拥堵）| `severe`（严重拥堵）| `unknown`（未知）

`MotionBehavior`: `cruise`（巡航）| `toll`（收费站）| `intersection`（红绿灯路口）| `ramp`（匝道）| `turn`（急转弯/掉头）| `serviceArea`（服务区）| `urbanStopStart`（城市起停）

`MotionEvent`: `{ type: stop|start|decel|turn; expectedCount; probability; label? }`

## 3. 路段是怎么切出来的（buildSegments）

高德驾车路线响应中，一条路线 = `steps[]`（导航步骤），每个 step 自带：

- `distance`（米）、`duration`（秒）、`polyline`（坐标串）
- `tmcs[]`（更细粒度的实时路况：status + distance + polyline，距离合计=step 距离）
- 注意：高德 step **没有 `road` 字段**，道路名从 `instruction`（如"沿G6京藏高速途径…"）提取

**切片规则（1 step → 1 segment）**：

1. `roadName` = 分层提取（G/S 编号+高速/国道/省道 → 含"高速" → 含"国道/省道" → 沿 X 兜底）；
2. `roadLevel` = 关键词（高速/国道/省道/环/快速）→ 收费里程>0 → 编号兜底；
3. `trafficStatus` = 该 step 内 tmcs 按距离加权的主导状态；
4. `stopDensity` = 道路等级基准 × 路况系数（高速 0.02 次/km，城区 2.0 次/km，拥堵 ×3~5）；
5. `avgSpeedKmh` = distance / duration（含路况影响；无 duration 时用等级巡航速度兜底）；
6. `coordsWgs84` = polyline 逐点 `gcj02ToWgs84` 逆转换（高德 GCJ-02 → 国际 WGS-84，供 DEM/天气匹配）。

验证：`npm run verify:segment`（38 项纯函数 + 真实线路）+ `npm run verify:split`（行为区 + 坡度切分 + 启停口径 76 项断言）。

### 3.1 L1 行为区标注（变速情况 + 变速概率）

`detectMotionBehavior(instruction, roadLevel, coords, traffic)` 按优先级：收费站 > 服务区 > 匝道 > 红绿灯路口 > 一般路口(城市) > 转弯(指令/航向角>40°) > 城市起停/巡航。概率默认值集中在 `MOTION_PROB`（可配置）：

| 事件 | 停车 P | 减速 P | 说明 |
| --- | --- | --- | --- |
| 收费站 ETC | 0.1 | 0.9 | 基本不停，减速通过 |
| 收费站 人工 | 0.95 | 0.99 | 指令含"人工/MTC" |
| 红绿灯路口 | 0.35~0.95 | 1.0 | 随实时路况（`INTERSECTION_STOP_PROB`），非固定值 |
| 一般路口（无信号灯） | 上式 ×0.8 | 1.0 | 让行通过为主 |
| 匝道 | 0.05 | 0.85 | 减速并线 |
| 急转弯 | 同路口 P | 0.7 | 城市/国道/省道的左右转发生在平面路口；高速几何弯道不计停车 |
| 掉头 | 0.3 | 1.0 | 接近停车 |
| 服务区 | 0.1 | 0.9 | 概率停车 |

**启停次数的单一口径（`expectedStopCount`）**：

1. 段内路口数 = 里程 × `INTERSECTION_DENSITY_PER_KM[等级]`，取**期望值**（不取整、不设"每段至少一个路口"下限）——保证把一段路切成 N 份后，各份期望停车之和与整段一致，切分方式不会改变全线启停能量；
2. 指令命中「红绿灯 / 路口 / 左右转」时，该显式事件**替代**其中一个背景路口（扣减 1），避免同一路口计两次；
3. 只有当段内一个停车事件都没有时（典型是高速巡航段），才退回 `stopDensity × 里程`。

因此 `stopDensity` 是兜底输入，**`expectedStopCount(seg)` 才是物理模型应消费的权威口径**。

### 3.2 L2 坡度自适应切分（demFetch.ts）

对所有 ≥1km 的段沿 DEM 剖面切分，条件（`splitGradeProfile`）：
1. 坡度变号（峰/谷）必切 → 每子段只上坡或只下坡；
2. 坡度带阈值：滑动窗口 500m 平均坡度偏离当前段均值 > ±1.5% → 切；
3. 长度上限 10km、巡航段最小 0.5km；尾部过短且坡度接近才并入前片。

碎段策略：只有"同路 + 无变速事件 + <0.2km"的纯延续碎段才并入前段（`mergeContinuationFragments`），行为区短段一律保留；离散变速事件只挂到事件段的首个子段（避免地形切分后重复计数）。

## 4. 企业模型 adapter 示例

企业 MATLAB 模型内部变量可能是 `dist_km`、`v_kmh`、`grade_pct`、`T_degC`……接入时写一个映射：

```ts
// 企业模型接入示例（占位）：字段映射适配层
export function toEnterpriseInput(segments: SegmentData[]) {
  return segments.map((s) => ({
    dist_km: s.distanceKm,
    v_kmh: s.avgSpeedKmh,
    // 坡度/海拔缺失时透传 null，由模型侧决定跳过还是插值。
    // 不要写成 `?? 0`：0% 在物理模型里是"平路"，等于把这段的坡度阻力抹掉。
    grade_pct: s.gradePercent,
    elev_m: s.elevationM,
    T_degC: s.temperatureC ?? 20,
    road_class: s.roadLevel,
    stop_per_km: s.stopDensity,
    motion: s.motionBehavior,
    stop_expected: expectedStopCount(s), // 权威启停口径，见 §3.1
    traffic: s.trafficStatus,
  }))
}
```

> 若模型侧确实无法接受 `null`，也应先做**显式插值**（用相邻有效段的坡度）并在结果里标注"该段坡度为推算值"，而不是静默按 0 计算。

## 5. 数据来源与状态

| 数据 | 来源 | Key | 状态 |
| --- | --- | --- | --- |
| 路线/步骤/路况 | 高德驾车路线规划 API | ✅ 需 Key | ✅ 已接入 |
| 坡度/海拔 | SRTM DEM（terrarium 瓦片，z14 ≈76m/px）；瓦片失败率 >20% 时切 opentopodata 兜底 | 免 Key | ✅ 源已验证（A2 接入） |
| 气温 | 高德天气 API / 线路区间插值 | 待开通 | ⏳ A3 |

> DEM 验证结论（`npm run verify:dem`）：terrarium 瓦片与 opentopodata 海拔偏差 1~8m；
> 491km 线路 z14 约 318 张瓦片 ≈ 30MB，可本地缓存，一次下载后重复使用。
