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
| `stopDensity` | number | 次/km | 停车/怠速密度 | 道路等级×路况系数推断 | - | ✅ |
| `temperatureC` | number|null | ℃ | 气温（影响辅助功耗/电堆效率） | 高德天气/区间插值（A3） | - | ⏳ A3 |
| `coordsWgs84` | [lng,lat][] | ° | 本段坐标序列（WGS-84） | 高德 GCJ-02 逆转换 | - | ✅ |
| `durationH` | number | h | 本段时长（distance/avgSpeed） | step.duration | cyc_secs | ✅ |

### 枚举值

`RoadLevel`: `highway`（高速）| `national`（国道）| `provincial`（省道）| `city`（城市/快速路）| `other`（其他）

`TrafficStatus`: `smooth`（畅通）| `slow`（缓行）| `congested`（拥堵）| `severe`（严重拥堵）| `unknown`（未知）

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

验证：`npm run verify:segment`（32 项纯函数自测 + 真实线路 491km/43 段）。

## 4. 企业模型 adapter 示例

企业 MATLAB 模型内部变量可能是 `dist_km`、`v_kmh`、`grade_pct`、`T_degC`……接入时写一个映射：

```ts
// 企业模型接入示例（占位）：字段映射适配层
export function toEnterpriseInput(segments: SegmentData[]) {
  return segments.map((s) => ({
    dist_km: s.distanceKm,
    v_kmh: s.avgSpeedKmh,
    grade_pct: s.gradePercent ?? 0,
    elev_m: s.elevationM ?? 0,
    T_degC: s.temperatureC ?? 20,
    road_class: s.roadLevel,
    stop_per_km: s.stopDensity,
    traffic: s.trafficStatus,
  }))
}
```

## 5. 数据来源与状态

| 数据 | 来源 | Key | 状态 |
| --- | --- | --- | --- |
| 路线/步骤/路况 | 高德驾车路线规划 API | ✅ 需 Key | ✅ 已接入 |
| 坡度/海拔 | SRTM DEM（terrarium 瓦片，z14 ≈76m/px）或 opentopodata 兜底 | 免 Key | ✅ 源已验证（A2 接入） |
| 气温 | 高德天气 API / 线路区间插值 | 待开通 | ⏳ A3 |

> DEM 验证结论（`npm run verify:dem`）：terrarium 瓦片与 opentopodata 海拔偏差 1~8m；
> 491km 线路 z14 约 318 张瓦片 ≈ 30MB，可本地缓存，一次下载后重复使用。
