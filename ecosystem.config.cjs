// PM2 生产配置：pm2 start ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'hydrogen-newline-predictor',
    script: 'server.js',
    cwd: __dirname,
    env: { NODE_ENV: 'production' },
    // VM 3.8GB；600M 太紧——报告/预测/AI 等重操作会把 Node 顶过上限被 PM2 强杀，
    // 导致内存中的测算任务丢失（任务过期）与重启瞬间的请求失败（Failed to fetch / JSON 截断）。
    max_memory_restart: '1500M',
    time: true,
    kill_timeout: 8000,
  }]
}