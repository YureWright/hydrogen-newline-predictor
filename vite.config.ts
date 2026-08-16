import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { fetchRoutePlan } from './src/route/amapRoute'
import { loadStations } from './src/route/stationLayer'

const __dirname = dirname(fileURLToPath(import.meta.url))

function send(res: any, code: number, obj: unknown) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}

const CITY_TABLE: Record<string, string> = {
  北京: '116.407,39.904', 天津: '117.19,39.13', 上海: '121.473,31.23',
  广州: '113.264,23.129', 深圳: '114.057,22.543', 乌兰察布: '113.13,40.99',
  呼和浩特: '111.75,40.84', 大同: '113.3,40.08', 石家庄: '114.51,38.04',
  唐山: '118.18,39.63', 济南: '117.12,36.65', 青岛: '120.38,36.07',
  郑州: '113.62,34.75', 武汉: '114.3,30.59', 西安: '108.94,34.34',
  成都: '104.07,30.67', 重庆: '106.55,29.56', 杭州: '120.15,30.28',
  南京: '118.78,32.06', 沈阳: '123.43,41.8', 长春: '125.32,43.82',
  哈尔滨: '126.53,45.8', 太原: '112.55,37.87', 银川: '106.23,38.49',
  兰州: '103.83,36.06', 西宁: '101.78,36.62', 乌鲁木齐: '87.62,43.83',
  拉萨: '91.14,29.65', 昆明: '102.83,24.88', 贵阳: '106.63,26.65',
  南宁: '108.32,22.82', 海口: '110.32,20.03', 福州: '119.3,26.08',
  厦门: '118.09,24.48', 南昌: '115.86,28.68', 长沙: '112.94,28.23',
  合肥: '117.28,31.86', 佛山: '113.12,23.02', 东莞: '113.75,23.02',
  中山: '113.39,22.52', 珠海: '113.57,22.27',
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'api-middleware',
      configureServer(server) {
        server.middlewares.use('/api', async (req: any, res: any) => {
          const url = new URL(req.url || '', 'http://localhost')
          const path = url.pathname
          const key = process.env.AMAP_KEY || ''
          try {
            if (path === '/suggest') {
              const kw = url.searchParams.get('keywords') || ''
              if (!key) return send(res, 200, { ok: false, msg: '未配置 AMAP_KEY' })
              const r = await fetch('https://restapi.amap.com/v3/assistant/inputtips?keywords=' + encodeURIComponent(kw) + '&key=' + key, { signal: AbortSignal.timeout(15000) })
              const j: any = await r.json()
              const tips = (j.tips || []).filter((t: any) => t.location).map((t: any) => ({ name: t.name, district: t.district || '', location: t.location }))
              return send(res, 200, { ok: true, source: 'amap-inputtips', tips: tips.slice(0, 8) })
            }
            if (path === '/geocode') {
              const addr = (url.searchParams.get('address') || '').trim()
              const hit = Object.entries(CITY_TABLE).find(([city]) => addr.includes(city) || city.includes(addr))
              if (hit) return send(res, 200, { ok: true, source: 'local-table', name: hit[0], location: hit[1] })
              if (!key) return send(res, 200, { ok: false, msg: '未配置 AMAP_KEY' })
              const r = await fetch('https://restapi.amap.com/v3/geocode/geo?address=' + encodeURIComponent(addr) + '&key=' + key, { signal: AbortSignal.timeout(15000) })
              const j: any = await r.json()
              if (j.status === '1' && j.geocodes && j.geocodes[0] && j.geocodes[0].location) {
                return send(res, 200, { ok: true, source: 'amap-geocode', name: j.geocodes[0].formatted_address || addr, location: j.geocodes[0].location })
              }
              return send(res, 200, { ok: false, msg: '地理编码失败：' + (j.info || '未知错误') + '（可在高德控制台为 Key 开通"地理编码/输入提示"权限）' })
            }
            if (path === '/route') {
              const origin = url.searchParams.get('origin') || ''
              const destination = url.searchParams.get('destination') || ''
              if (!origin || !destination) return send(res, 400, { ok: false, msg: '缺少 origin/destination' })
              if (!key) return send(res, 200, { ok: false, msg: '未配置 AMAP_KEY' })
              const plan = await fetchRoutePlan(origin, destination)
              return send(res, 200, { ok: true, stations: loadStations(join(__dirname, 'data', 'stations.geojson')), routes: plan.routes })
            }
            if (path === '/stations') {
              return send(res, 200, { ok: true, stations: loadStations(join(__dirname, 'data', 'stations.geojson')) })
            }
            return send(res, 404, { ok: false, msg: 'unknown api: ' + path })
          } catch (e: any) {
            return send(res, 500, { ok: false, msg: 'server error: ' + (e.message || e) })
          }
        })
      },
    },
  ],
  server: { port: 5174, host: true },
})
