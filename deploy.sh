#!/usr/bin/env bash
# 部署脚本（在服务器项目目录执行）：拉码 → 装依赖 → Python venv → 构建 → PM2 重启
set -e
cd "$(dirname "$0")"

echo "[1/6] git pull"
git pull --ff-only

echo "[2/6] npm install"
npm install

echo "[3/6] Python venv + 依赖"
if [ ! -d .venv ]; then python3 -m venv .venv; fi
.venv/bin/pip install -r ml/requirements.txt

echo "[4/6] 确保 .env 里有 PYTHON 指向 venv"
PYBIN="$(pwd)/.venv/bin/python"
if [ -f .env ]; then
  grep -q '^PYTHON=' .env || echo "PYTHON=$PYBIN" >> .env
else
  echo "PYTHON=$PYBIN" > .env
fi
echo "   （.env 已含 PYTHON=$PYBIN；如首次部署请另填 AMAP_KEY / QWEATHER_KEY 等）"

echo "[5/6] 前端构建"
npm run build

echo "[6/6] PM2 重启"
if command -v pm2 >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs || pm2 start ecosystem.config.cjs
  pm2 save
else
  echo "  ⚠ 未安装 pm2，可用: npm i -g pm2"
  echo "  或直接后台运行: nohup node server.js > server.log 2>&1 &"
fi

echo "✅ 部署完成。查看日志: pm2 logs hydrogen-newline-predictor"