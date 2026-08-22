# ML：段级氢耗预测（工况合成 + 梯度提升树）

用两辆 H49 氢能重卡实车 60s 数据训练：系统分段（均速/坡度/温度/道路等级）→ **工况合成**（模板拼接出 60s v/a 序列）→ 深度特征（加速/空阻/上坡能量、速度分位数、启停占比）→ **HistGB 段级模型** → 每段氢耗(kg)。

## 文件
- `mass_est.py`：行程级能量平衡质量反推（输入实车电机 V/I + 速度/坡度 → 每趟车一个质量，输出 `mass_est.json`；`_v1/_v2_feat.csv` 训练时按行程取 mass_kg）
- `feat.py`：特征工程 + 工况合成（训练/预测共用，保证口径一致）
- `train.py`：读实车回填特征（根目录 `_v1_feat.csv`/`_v2_feat.csv`，本地 gitignore）→ 5km 段聚合 → 训练 → 导出模型
- `predict.py`：stdin 收段特征 JSON → 合成工况 → 预测 → stdout 每段氢耗 + 总计
- `model.joblib` / `templates.json` / `meta.json`：已训练模型 + 工况片段库 + 元数据（随仓库提交，预测开箱即用）

## 重新训练
```bash
pip install -r ml/requirements.txt
cd hydrogen-newline-predictor
python ml/train.py        # 需要本地 _v1_feat.csv / _v2_feat.csv（由回填脚本生成，含 GPS，勿提交）
```

## 性能
- 按行程分组 CV（预测全新线路）：R²≈0.384，RMSE≈0.048 kg/km（2026-08-22 修正 haversine + 加入行程级质量特征后重训，见 docs/WORKLOG.md）
- **质量特征**：`mass_kg`（总质量 kg）= 整备 9.7t + 载重；训练用行程级能量平衡反推（`mass_est.py`），预测用用户输入载重。**注意**：反推只覆盖部分行程（车1 3 趟 / 车2 14 趟），缺失用该车中位填充；模型对载重是离散档位响应，可靠载重敏感性依赖物理模型
- 目标：氢气剩余量差分（= h2_consum_per_sec 同源，每 60s 消耗 kg；中位 ≈5.12 kg/100km）
- 单位：km/h / kg/km；预测输出 kg 与 kg/100km

## 训练数据来源（ml/backfill.py）

训练特征不是凭空来的：`ml/backfill.py` 读取原始 60s 实车 CSV（根目录 车辆1/车辆2，gitignore），按每个 GPS 点（经纬度 + 采集时刻）回填三块**真实**数据：

- **DEM 海拔/坡度**：terrarium 高程瓦片（elevation-tiles-prod.s3.amazonaws.com）
- **ERA5 历史天气**：open-meteo archive-api（温度/风速/湿度/降水，按点时刻匹配最近整点）
- **道路等级**：高德 regeo 逆地理编码 → 道路名 → 关键词规则推断

输出 `_v1_feat.csv` / `_v2_feat.csv`（本地，含 GPS，勿提交）→ `train.py` 聚合训练。

预测链路使用前端实时抓取（高德路线 + DEM + OSM + QWeather），与训练来源存在口径差异，详见根 README「训练与预测的数据来源与口径差异」。

## 数据隐私
实车数据（含 GPS 轨迹）一律不提交仓库，.gitignore 已覆盖；模型与工况片段库（无坐标）随仓库提交。

## 单位换算（官方口径，《数据计算方法》文档）
实际值 = 原始值 × rate + offset：
- `speed_车速` ×0.1 → km/h（本方案 train 聚合时 ÷10）
- `lon/lat` ×1e-6 → 度（÷1e6）
- `h2_remain_氢气剩余量` ×0.01 → kg；**CSV 已按 ×0.01 换算为实际 kg**，目标 = 其相邻差分（kg/60s）→ 段 kg/km
- 温度类字段 rate=1, offset=−40（原始值需 −40 才为℃）；本方案未使用车辆温度，改用 ERA5 环境温度
- 原始「纵向加速度」列不在官方字段表中（实为经度错位），弃用，改用 60s 速度差分
