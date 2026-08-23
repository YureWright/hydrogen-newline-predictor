# 部署指南（Azure Linux VM / 任意 Linux 服务器）

> 适用：本项目（前端 + 后端一体：`vite.config.ts` 中间件提供 `/api/*`，Python 提供模型预测）。
> 部署方式：**Node 常驻进程（`server.js`，复用 vite 中间件 + 伺服 `dist/`）+ Python venv + PM2 守护**。

## 0. 架构一句话

```
浏览器 ──> Node server.js (:5174)
            ├─ /api/*      → vite.config.ts 中间件（高德/DEM/OSM/天气/AI/氢耗预测）
            │                └─ 预测时 spawn Python（ml/predict.py / physics.py）
            └─ 其余静态    → dist/（前端构建产物，含 /physics-lab.html 与 SPA 回退）
```

## 1. 服务器准备（Azure Linux VM，一次性）

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install -y git curl python3 python3-venv build-essential

# Node 18+（推荐 20 LTS）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PM2（进程守护，崩溃自动重启）
sudo npm i -g pm2

node -v && python3 --version   # 确认
```

> Azure 网络：给 VM 的 **网络安全组(NSG)** 加一条入站规则放行 **TCP 5174**（来源可先设为 `Internet`）；Ubuntu 内若开了 ufw 也要放行：
> `sudo ufw allow 5174/tcp`

## 2. 拉代码 + 配置密钥

```bash
git clone git@github.com:YureWright/hydrogen-newline-predictor.git
cd hydrogen-newline-predictor
cp .env.example .env
nano .env    # 填入：
#   AMAP_KEY=你的高德Web服务key（必填）
#   QWEATHER_KEY= / QWEATHER_HOST=  （天气，建议填）
#   DEEPSEEK_API_KEY=  （AI 评估，可选）
#   OPENWEATHER_KEY=   （天气兜底，可选）
```

## 3. 一键部署

```bash
chmod +x deploy.sh
./deploy.sh
```

脚本会：git pull → npm install → 建 `.venv` 并装 Python 依赖（并把 `PYTHON=.venv/bin/python` 写进 `.env`）→ `npm run build` → PM2 启动/重启。

## 4. 验证

```bash
curl http://<你的IP>:5174/api/stations            # 应返回 {"ok":true,...571...}
curl http://<你的IP>:5174/                        # 首页 HTML
pm2 logs hydrogen-newline-predictor               # 查看日志
```

浏览器访问 `http://<你的IP>:5174` 即可（含 `/physics-lab.html` 物理实验室）。

## 5. 以后更新代码

```bash
cd hydrogen-newline-predictor && git pull && ./deploy.sh
```

## 常见问题

| 问题 | 处理 |
| --- | --- |
| 预测报错 "python exit ..." | 确认 `.env` 里 `PYTHON` 指向 venv 的 python（`echo $PYTHON`），手动跑 `PYTHON=.venv/bin/python .venv/bin/python ml/predict.py` 看报错 |
| 高德/和风请求慢或失败 | Azure 区域尽量选亚太（香港/新加坡/东京）；高德 Web服务 API 一般海外可通，但国内访问延迟可能高 |
| 想用域名 + 80/443 | 国际版 Azure 可加 DNS 解析后直接用（可上 https）；Azure 中国（世纪互联）域名需 ICP 备案 |
| 端口被占 | 改 `PORT` 环境变量后重启（`PORT=8080 pm2 reload ...` 或 `.env` 里写 `PORT=8080`） |

## 备选：Azure App Service（Linux，Node 运行时）

App Service 也能跑：启动命令设为 `node server.js`，并安装 Python 扩展或用 `python` 启动命令装依赖；因涉及 Python 子进程与构建，**推荐先用 VM**，需要再切 App Service。

## 安全提醒

- `.env`、`data/*-cache/`、`node_modules/`、`dist/` 已被 `.gitignore` 排除，不会入库。
- 部署时密钥只写在服务器上的 `.env`，不要提交。