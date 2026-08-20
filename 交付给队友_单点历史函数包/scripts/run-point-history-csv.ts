/**
 * 将车辆分钟聚合 CSV 的 time / lat / lon 逐行送入单点历史数据函数。
 * 原始 CSV 只读；结果另存到 outputs/point-history-batch/。
 *
 * 用法：
 * npm run point:batch -- /绝对路径/车辆1.csv /绝对路径/车辆2.csv
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { POINT_HISTORY_HEADERS, queryPointHistoryRow } from '../src/route/pointHistory'

const OUTPUT_DIR = join(process.cwd(), 'outputs', 'point-history-batch')
/** 车辆轨迹不出本机：即使后续有人误传了 API Key，也禁止这批处理访问外部服务。 */
const offlineFetch = (async () => {
  throw new Error('本批处理已强制离线，禁止上传车辆位置与时间')
}) as typeof fetch

function parseCsvLine(line: string): string[] {
  const cells: string[] = []
  let value = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i++ }
      else quoted = !quoted
    } else if (char === ',' && !quoted) {
      cells.push(value); value = ''
    } else value += char
  }
  cells.push(value)
  return cells
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function normalizeCoordinate(raw: string, axis: 'lat' | 'lon'): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${axis} 不是有效数字`)
  const limit = axis === 'lat' ? 90 : 180
  // 这两份车辆 CSV 的经纬度形如 32156790 / 112202282，即实际值 × 1,000,000。
  const normalized = Math.abs(value) > limit ? value / 1_000_000 : value
  if (Math.abs(normalized) > limit) throw new Error(`${axis} 超出范围：${raw}`)
  return normalized
}

function outputName(source: string) {
  return basename(source).replace(/\(1\)(?=\.csv$)/, '').replace(/\.csv$/i, '_函数结果.csv')
}

async function runOne(source: string) {
  const raw = await readFile(source, 'utf8')
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.length > 0)
  if (lines.length < 2) throw new Error(`${basename(source)} 没有可处理的数据行`)

  const headers = parseCsvLine(lines[0])
  const timeIndex = headers.indexOf('time_数据采集时间')
  const latIndex = headers.indexOf('lat_纬度')
  const lonIndex = headers.indexOf('lon_经度')
  if (timeIndex < 0 || latIndex < 0 || lonIndex < 0) {
    throw new Error(`${basename(source)} 缺少 time_数据采集时间、lat_纬度 或 lon_经度`)
  }

  // 队友的交付口径：原始文件只保留三个输入，其余车辆遥测变量全部丢弃。
  const outputHeaders = [
    'time_数据采集时间', 'lat_纬度（已×10^-6）', 'lon_经度（已×10^-6）', ...POINT_HISTORY_HEADERS,
  ]
  const output: string[] = [outputHeaders.map(csvCell).join(',')]
  const errors: Array<{ row: number; reason: string }> = []
  let processed = 0

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i])
    while (values.length < headers.length) values.push('')
    try {
      const lat = normalizeCoordinate(values[latIndex], 'lat')
      const lng = normalizeCoordinate(values[lonIndex], 'lon')
      // 不传 API Key 且强制离线：这批日期已超出历史天气 10 天窗口，避免 2,298 次无效外部请求、配额消耗和轨迹外传。
      const result = await queryPointHistoryRow({ lng, lat, time: values[timeIndex] }, { fetchFn: offlineFetch })
      const row = [values[timeIndex], lat.toFixed(6), lng.toFixed(6), ...POINT_HISTORY_HEADERS.map((header) => result.row[header])]
      output.push(row.map(csvCell).join(','))
      processed++
    } catch (e: any) {
      errors.push({ row: i + 1, reason: e?.message || String(e) })
      output.push([values[timeIndex], '', '', ...POINT_HISTORY_HEADERS.map(() => '')].map(csvCell).join(','))
    }
  }

  await mkdir(OUTPUT_DIR, { recursive: true })
  const destination = join(OUTPUT_DIR, outputName(source))
  await writeFile(destination, '\uFEFF' + output.join('\n') + '\n', 'utf8')
  return { source: basename(source), destination, inputRows: lines.length - 1, processed, failed: errors.length, errors: errors.slice(0, 20) }
}

async function main() {
  const sources = process.argv.slice(2)
  if (!sources.length) throw new Error('请传入至少一个车辆 CSV 的绝对路径')
  const reports = []
  for (const source of sources) reports.push(await runOne(source))
  const reportPath = join(OUTPUT_DIR, '批处理报告.json')
  await writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2) + '\n', 'utf8')
  for (const report of reports) {
    console.log(`完成 ${report.source}：成功 ${report.processed}/${report.inputRows}，失败 ${report.failed}`)
    console.log(`结果：${report.destination}`)
  }
  console.log(`报告：${reportPath}`)
}

main().catch((e) => {
  console.error('批处理失败：' + (e?.message || String(e)))
  process.exit(1)
})
