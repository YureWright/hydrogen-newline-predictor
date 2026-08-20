/**
 * 单点历史路段样本 CLI。
 * 用法：npm run point:row -- 116.407387 39.904179 "2026-08-01 10:07"
 * CSV：npm run point:row -- 116.407387 39.904179 "2026-08-01 10:07" --csv
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pointRowToCsv, queryPointHistoryRow } from '../src/route/pointHistory'

function loadLocalEnv() {
  const envPath = join(process.cwd(), '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim()
  }
}

async function main() {
  loadLocalEnv()
  const args = process.argv.slice(2)
  const csv = args.includes('--csv')
  const values = args.filter((x) => x !== '--csv')
  if (values.length < 3) {
    throw new Error('用法：npm run point:row -- 经度 纬度 "YYYY-MM-DD HH:mm" [--csv]')
  }
  const [lngText, latText, ...timeParts] = values
  const result = await queryPointHistoryRow(
    { lng: Number(lngText), lat: Number(latText), time: timeParts.join(' ') },
    {
      amapKey: process.env.AMAP_KEY,
      qweatherKey: process.env.QWEATHER_KEY,
      qweatherJwt: process.env.QWEATHER_JWT,
      qweatherHost: process.env.QWEATHER_HOST,
    },
  )
  if (csv) console.log(pointRowToCsv(result.row))
  else console.log(JSON.stringify(result, null, 2))
}

main().catch((e) => {
  console.error('查询失败：' + (e?.message || String(e)))
  process.exit(1)
})
