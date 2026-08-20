/** 单点历史路段样本：纯函数与模拟接口验证，不消耗真实 API 配额。 */
import {
  POINT_HISTORY_HEADERS,
  parsePointTime,
  pointRowToCsv,
  queryPointHistoryRow,
} from '../src/route/pointHistory'

let failed = 0
function assert(name: string, condition: boolean, detail = '') {
  if (condition) console.log('  PASS', name)
  else { failed++; console.error('  FAIL', name, detail) }
}

async function main() {
  const parsed = parsePointTime('2026/8/1 10:07')
  assert('兼容聊天中的时间格式', parsed.getFullYear() === 2026 && parsed.getMonth() === 7 && parsed.getDate() === 1)
  const singleDigitHour = parsePointTime('2026/8/10 0:47')
  assert('兼容车辆文件的单数字小时', singleDigitHour.getHours() === 0 && singleDigitHour.getMinutes() === 47)

  const input = { lng: 116.407387, lat: 39.904179, time: '2026-08-01 10:07' }
  const options = { now: new Date('2026-08-21T12:00:00+08:00') }
  const first = await queryPointHistoryRow(input, options)
  const second = await queryPointHistoryRow(input, options)
  assert('超过10天自动标记模拟天气', first.meta.weatherSource === 'simulated')
  assert('整体明确标记模拟测试', first.meta.dataMode === 'simulation-test')
  assert('同一输入重复调用结果一致', JSON.stringify(first.row) === JSON.stringify(second.row))
  assert('输出恰好22列', Object.keys(first.row).length === 22, String(Object.keys(first.row).length))
  assert('输出列名与CSV模板一致', POINT_HISTORY_HEADERS.every((key) => Object.prototype.hasOwnProperty.call(first.row, key)))
  assert('里程与速度为正数', first.row['里程km'] > 0 && first.row['均速km/h'] > 0)
  assert('模拟警告没有冒充真实数据', first.meta.warnings.some((x) => x.includes('仅供测试')))
  const csv = pointRowToCsv(first.row)
  assert('CSV包含表头和一行数据', csv.split('\n').length === 2)

  const mockFetch: typeof fetch = (async (urlValue: any) => {
    const url = new URL(String(urlValue))
    const json = async () => {
      if (url.hostname === 'restapi.amap.com') {
        return { status: '1', regeocode: { roads: [{ name: '东长安街', distance: '8' }] } }
      }
      if (url.pathname === '/geo/v2/city/lookup') {
        return { code: '200', location: [{ id: '101011600', name: '东城' }] }
      }
      if (url.pathname === '/v7/historical/weather') {
        return { code: '200', weatherHourly: [
          { time: '2026-08-20 09:00', temp: '24', windSpeed: '8', humidity: '70', precip: '0', text: '多云' },
          { time: '2026-08-20 10:00', temp: '25', windSpeed: '10', humidity: '68', precip: '0', text: '晴' },
        ] }
      }
      return { code: '404' }
    }
    return { ok: true, status: 200, json } as Response
  }) as typeof fetch
  const recent = await queryPointHistoryRow(
    { lng: 116.407387, lat: 39.904179, time: '2026-08-20 10:07' },
    {
      now: new Date('2026-08-21T12:00:00+08:00'),
      amapKey: 'test-amap-key',
      qweatherKey: 'test-weather-key',
      qweatherHost: 'example.qweatherapi.com',
      fetchFn: mockFetch,
    },
  )
  assert('近期历史天气走真实历史分支', recent.meta.weatherSource === 'qweather-history')
  assert('坐标反查取得道路名', recent.row.道路 === '东长安街')
  assert('选取最接近输入时刻的小时天气', recent.row['温度℃'] === 25 && recent.row.天气 === '晴')

  let futureRejected = false
  try {
    await queryPointHistoryRow(
      { lng: 116.4, lat: 39.9, time: '2026-08-22 10:00' },
      { now: new Date('2026-08-21T12:00:00+08:00') },
    )
  } catch { futureRejected = true }
  assert('拒绝未来时间', futureRejected)

  if (failed) {
    console.error(`❌ ${failed} 项失败`)
    process.exit(1)
  }
  console.log('✅ 单点历史路段样本验证全部通过')
}

main().catch((e) => {
  console.error('  FAIL 验证异常：', e)
  process.exit(1)
})
