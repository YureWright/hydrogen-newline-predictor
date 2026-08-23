// PM2 生产配置：pm2 start ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'hydrogen-newline-predictor',
    script: 'server.js',
    cwd: __dirname,
    env: { NODE_ENV: 'production' },
    max_memory_restart: '600M',
    time: true,
    kill_timeout: 8000,
  }]
}