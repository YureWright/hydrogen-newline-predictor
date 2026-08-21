# ML：段级氢耗预测（工况合成 + 梯度提升树）

用两辆 H49 氢能重卡实车 60s 数据训练：系统分段（均速/坡度/温度/道路等级）→ **工况合成**（模板拼接出 60s v/a 序列）→ 深度特征（加速/空阻/上坡能量、速度分位数、启停占比）→ **HistGB 段级模型** → 每段氢耗(kg)。

## 文件
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
- 按行程分组 CV（预测全新线路）：R²≈0.50，RMSE≈0.046 kg/km
- 目标：氢气剩余量差分（= h2_consum_per_sec 同源，每 60s 消耗 kg；中位 ≈5.2 kg/100km）
- 单位：km/h / kg/km；预测输出 kg 与 kg/100km

## 数据隐私
实车数据（含 GPS 轨迹）一律不提交仓库，.gitignore 已覆盖；模型与工况片段库（无坐标）随仓库提交。

## 单位换算（官方口径，《数据计算方法》文档）
实际值 = 原始值 × rate + offset：
- `speed_车速` ×0.1 → km/h（本方案 train 聚合时 ÷10）
- `lon/lat` ×1e-6 → 度（÷1e6）
- `h2_remain_氢气剩余量` ×0.01 → kg；**CSV 已按 ×0.01 换算为实际 kg**，目标 = 其相邻差分（kg/60s）→ 段 kg/km
- 温度类字段 rate=1, offset=−40（原始值需 −40 才为℃）；本方案未使用车辆温度，改用 ERA5 环境温度
- 原始「纵向加速度」列不在官方字段表中（实为经度错位），弃用，改用 60s 速度差分
