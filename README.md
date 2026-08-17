# 新线路氢耗预测工具（T05 · 命题二）

> 氢能车辆运营智能分析与决策助手 —— 面向市场销售人员的"新线路氢耗预测"Web 工具
> 赛题：浦发·IGNITE 未来能源黑客松 · T05（命题二：新线路氢耗预测工具）
> 企业：北京海珀特氢能科技有限公司

## 项目简介

输入**起点/终点地址**，自动获取候选路线、逐段实时路况、高速占比与沿线加氢站，为"氢车跑这条新线路是否可行、成本多少"提供数据化决策依据。

当前为**路线路况模块**（第一个模块），后续将接入氢耗物理模型、成本引擎、补能规划与敏感性分析。

## 已实现功能

| 功能 | 说明 |
| --- | --- |
| 地址 → 坐标 | 输入城市/地址自动解析：高德地理编码优先（精确到门址/POI），失败回退内置城市表（城市中心） |
| 候选路线 | 高德驾车路线规划，最多 3 条（里程/时长/过路费/平均速度） |
| 高速占比 | 基于收费里程/总里程的代理指标 |
| 逐段实时路况 | 畅通/缓行/拥堵/严重拥堵里程 + 拥堵占比 |
| 主要道路 | 从导航指令提取道路名并按里程排序 |
| 沿线加氢站 | 571 座本地图层，路线 20km 内加氢站（距离/价格/压力/枪数） |
| 前端展示 | 路线卡片 + Leaflet 地图（路线分色、加氢站分色高亮） |
| 分段切片（A1） | 路线切成路段序列（SegmentData 契约）：道路名/等级/均速/实时路况/停车密度/坐标(WGS-84)，供物理模型直接消费 |
| DEM 数据源验证 | SRTM 坡度/海拔数据源可行性（terrarium 瓦片 z14 ≈76m/px，opentopodata 免 Key 兜底） |
| 路段高程提取（A2） | 对 43 段路线逐段采样 DEM，填充坡度/海拔/累计爬升下降（terrarium 瓦片 + 本地缓存 + opentopodata 兜底） |
| 路段数据分析面板 | 点击路线卡片查看：路段数据表（可排序）+ 海拔剖面/道路等级/路况/均速可视化 + AI 智能评估（DeepSeek） |

## 快速开始

### 环境要求

- Node.js 18+（开发环境 v24）
- 高德开放平台 Web 服务 Key（https://lbs.amap.com 免费注册）

### 安装

```bash
cd hydrogen-newline-predictor
npm install
```

### 配置高德 API Key（必须）

本项目依赖高德开放平台 Web 服务 API，**需要你申请一个 Key 并配置到环境变量或 .env 文件**。

#### 第 1 步：申请高德 Key（免费）

1. 打开 https://lbs.amap.com 注册/登录；
2. 控制台 → 应用管理 → 我的应用 → **创建新应用**；
3. 在应用下 **添加 Key**，服务平台选 **「Web服务」**；
4. **勾选服务权限**（关键）：
   - ✅ **驾车路线规划**（必选，路线/路况数据来源）
   - ✅ **地理编码**（推荐，任意地址→坐标）
   - ✅ **输入提示**（推荐，地址自动补全）
   - ✅ **交通态势 / 交通事件**（可选，后续安全权重用）
5. 创建后得到 Key（形如 `693cd1...` 的 32 位串）。

#### 第 2 步：配置 Key（二选一）

**方式 A：系统环境变量（推荐，不落盘）**

```bash
# PowerShell（当前会话）
$env:AMAP_KEY='你的key'

# PowerShell（永久，写入用户环境）
setx AMAP_KEY "你的key"

# macOS / Linux
export AMAP_KEY='你的key'        # 当前会话
echo 'export AMAP_KEY="你的key"' >> ~/.zshrc   # 永久
```

**方式 B：.env 文件**

```bash
# 复制示例并填入你的 Key（.env 已被 .gitignore 忽略，不会提交）
cp .env.example .env
# 编辑 .env：AMAP_KEY=你的key
```

> 优先级：系统环境变量 > .env 文件（已存在环境变量时 .env 不会覆盖）。
> ⚠️ 请勿把 Key 写进任何会被提交的文件（如 README、代码、.env.example）。

### 配置 DeepSeek API Key（AI 评估功能，可选）

AI 评估使用 DeepSeek（OpenAI 兼容接口），Key 通过环境变量注入，**不写入任何文件**：

```bash
# PowerShell
$env:DEEPSEEK_API_KEY='你的key'
# 可选：自定义端点 / 模型（默认 https://api.deepseek.com / deepseek-v4-flash）
$env:DEEPSEEK_BASE_URL='https://api.deepseek.com'
$env:DEEPSEEK_MODEL='deepseek-v4-flash'
```

或写入 `.env`（已被 gitignore）：`DEEPSEEK_API_KEY=...`。未配置时 AI 评估按钮会提示配置，其余功能不受影响。

#### 第 3 步：验证

```bash
npm run dev        # 打开 http://localhost:5174，输入起终点查询
npm run verify:route   # 命令行自测 + 真实线路验证
npm run verify:segment # A1 分段切片自测（32 项纯函数 + 真实线路分段）
npm run verify:dem     # DEM 数据源验证（需联网）
```

地址解析：优先调用高德地理编码（精确到门址/POI）；若接口失败（权限/配额）或未配置 Key，回退到内置城市表（44 个主要城市，返回城市中心点，界面会提示）。

### 运行

```bash
npm run dev          # 前端展示 → http://localhost:5174
npm run demo         # 命令行路线路况 Demo（交互输入起终点）
npm run demo -- 113.13,40.99 117.19,39.13   # 指定坐标
npm run verify:route # 纯函数自测 + 3 条真实线路验证
npm run verify:segment # A1 分段切片自测 + 真实线路分段
npm run verify:dem     # DEM 数据源验证（opentopodata vs terrarium 瓦片）
npm run enrich         # 路段高程提取 CLI（预热 DEM 缓存 + 打印坡度/海拔路段表）
```

## API（Vite dev server 内置中间件，同源免 CORS）

| 接口 | 说明 |
| --- | --- |
| `GET /api/geocode?address=北京` | 地址 → 坐标（内置城市表 + 高德地理编码） |
| `GET /api/suggest?keywords=乌兰` | 地名输入提示（需高德"输入提示"权限） |
| `GET /api/route?origin=lng,lat&destination=lng,lat` | 候选路线 + 逐段路况 + 沿线加氢站 |
| `GET /api/stations` | 全国加氢站图层（571 座） |
| `GET /api/segments?origin&destination&index` | 候选路线分段切片 + DEM 高程/坡度（terrarium 瓦片 + 缓存） |
| `POST /api/ai/evaluate` | AI 智能评估（DeepSeek，需 DEEPSEEK_API_KEY） |

## 项目结构

```
hydrogen-newline-predictor/
├── src/
│   ├── route/               # 路线路况核心模块（纯函数可测）
│   │   ├── types.ts         #   类型定义（含 SegmentData 契约）
│   │   ├── parse.ts         #   解析层（路况/高速占比/道路/距离）
│   │   ├── coords.ts        #   坐标系 GCJ-02 ↔ WGS-84 + polyline 解析
│   │   ├── segment.ts       #   A1 分段切片（steps+tmcs+polyline → SegmentData）
│   │   ├── dem.ts           #   DEM 高程瓦片解码与采样（Node 侧）
│   │   ├── demFetch.ts       #   DEM 瓦片下载/缓存 + 路段高程填充（Node 侧）
│   │   ├── ai.ts             #   DeepSeek AI 评估（Node 侧）
│   │   ├── amapRoute.ts     #   高德驾车路线规划调用（含 fetchRouteWithSegments）
│   │   └── stationLayer.ts  #   加氢站图层 + 沿线搜索
│   ├── components/          # MapView / RouteCard / SegmentsPanel（路段表+图表+AI）/ Charts / MarkdownLight
│   ├── App.tsx              # 主页面
│   └── styles.css
├── scripts/
│   ├── demo.ts              # 命令行交互 Demo
│   ├── verify-route.ts      # 自测 + 真实线路验证
│   ├── verify-segment.ts    # A1 分段切片自测（32 项 + 真实线路）
│   └── verify-dem.ts        # DEM 数据源验证
├── data/stations.geojson    # 加氢站数据（571 座，GCJ-02）
├── docs/
│   ├── prototype-spec.md    # 产品原型设计规格（Figma 用）
│   └── segment-contract.md  # SegmentData 输入契约（A1）
├── vite.config.ts           # Vite + API 中间件
└── package.json             # 依赖与脚本
```

## 数据来源与合规

- 路线/路况：高德开放平台 Web 服务 API（需 Key）
- 加氢站：加氢服务地图公开分页接口（571 座，采集于 2026-08-15）
- 数据用于赛题演示与学习；站点状态为采集时刻快照，实际运营数据请以官方渠道为准
- 本仓库不包含任何账号、口令、Token 等敏感信息（Key 通过环境变量注入）

## 路线图

- [x] 路线路况模块（候选路线 + 实时路况 + 加氢站）
- [x] 分段切片 + SegmentData 输入契约（A1，见 docs/segment-contract.md）
- [x] DEM 数据源验证（terrarium 瓦片 / opentopodata 兜底）
- [x] 坡度/海拔提取（A2：逐段采样 DEM，填充 gradePercent/elevationM/爬升下降）
- [x] 路段数据分析面板（数据表 + 可视化 + AI 评估）
- [ ] 高德地理编码/输入提示权限接入（任意地址 + 自动补全）
- [ ] 氢耗物理模型（纵向动力学 + 工况合成 + 效率折算 + 基准校准）
- [ ] 成本引擎（燃料/路桥/人工/维保 + 柴油对比）
- [ ] 补能规划（续航约束 + 绕行加氢站）
- [ ] 敏感性分析 / 多方案对比 / 报告导出
- [ ] 7 页 UI（见 docs/prototype-spec.md）

## License

[MIT](LICENSE)
