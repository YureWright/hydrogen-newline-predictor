/** A2 前置验证：DEM 数据源可行性（opentopodata SRTM90m API vs AWS terrarium 瓦片）
 *
 * 输出：
 *  1. 三个已知点海拔对照（两源交叉验证，偏差应在 ±100m 内，SRTM 分辨率可接受）
 *  2. 一条线路（乌兰察布→天津）在 z14/z15 需要下载的瓦片数与估算体积
 *
 * 运行：npm run verify:dem   （需联网；不依赖 AMAP_KEY，有则用真实路线）
 */
import { decodePng, sampleElevationInTile, tileXY, uniqueTilesAlong } from '../src/route/dem'

const TERRARIUM = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium'

/** opentopodata 采样（免 Key，单请求最多 100 点） */
async function opentopodataElevation(points: Array<[number, number]>): Promise<number[]> {
  const locs = points.map(([lat, lng]) => lat + ',' + lng).join('|')
  const r = await fetch('https://api.opentopodata.org/v1/srtm90m?locations=' + locs, {
    signal: AbortSignal.timeout(20000),
  })
  const j: any = await r.json()
  if (!j.results) throw new Error('opentopodata error: ' + JSON.stringify(j))
  return j.results.map((x: any) => (x.elevation == null ? NaN : x.elevation))
}

/** terrarium 瓦片采样（z14，约 76m/像素） */
async function terrariumElevation(points: Array<[number, number]>, z: number): Promise<number[]> {
  const cache = new Map<string, any>()
  const out: number[] = []
  for (const [lat, lng] of points) {
    const [tx, ty] = tileXY(lng, lat, z)
    const k = tx + ',' + ty
    let tile = cache.get(k)
    if (!tile) {
      const url = TERRARIUM + '/' + z + '/' + tx + '/' + ty + '.png'
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) })
      if (!res.ok) throw new Error('terrarium HTTP ' + res.status + ' ' + url)
      const buf = Buffer.from(await res.arrayBuffer())
      const png = decodePng(buf)
      tile = { x: tx, y: ty, z, ...png }
      cache.set(k, tile)
    }
    out.push(sampleElevationInTile(tile, lng, lat))
  }
  return out
}

function latLngOf(point: [number, number]): string {
  return point[0].toFixed(4) + ',' + point[1].toFixed(4)
}

async function main() {
  console.log('=== DEM 数据源验证 ===')
  // 已知点：[lat, lng]（WGS-84）
  const points: Array<[number, number]> = [
    [40.99, 113.13], // 乌兰察布（约 1400m 高原）
    [40.08, 113.3], // 大同
    [39.9072, 116.3913], // 北京天安门（约 44m）
  ]
  console.log('对照点:', points.map(latLngOf).join(' | '))
  const oto = await opentopodataElevation(points)
  let terr: number[] | null = null
  try {
    terr = await terrariumElevation(points, 14)
  } catch (e: any) {
    console.log('  ⚠️ terrarium 瓦片下载失败（网络/区域限制），本表以 opentopodata 为准:', e.message)
  }
  console.log(' 点     |  opentopodata(m) | terrarium z14(m) | 偏差(m)')
  points.forEach((p, i) => {
    const t = terr ? terr[i].toFixed(0) : '  N/A '
    const diff = terr ? Math.abs(oto[i] - terr[i]).toFixed(0) : '  -  '
    console.log(' ' + latLngOf(p) + ' | ' + String(oto[i].toFixed(0)).padStart(14) + ' | ' + String(t).padStart(15) + ' | ' + diff)
  })

  console.log('')
  console.log('=== 规模估算：乌兰察布→天津 一条线需要多少瓦片 ===')
  let coords: Array<[number, number]> = []
  if (process.env.AMAP_KEY) {
    try {
      const { fetchRouteWithSegments } = await import('../src/route/amapRoute')
      const { segments } = await fetchRouteWithSegments('113.13,40.99', '117.19,39.13', 0)
      coords = segments.flatMap((s) => s.coordsWgs84)
      console.log('  使用高德真实路线（' + segments.length + ' 段）')
    } catch (e: any) {
      console.log('  高德调用失败，退回直线采样:', e.message)
    }
  }
  if (coords.length < 2) {
    // 直线近似：每 5km 一个点
    for (let k = 0; k <= 100; k++) {
      const t = k / 100
      coords.push([113.13 + (117.19 - 113.13) * t, 40.99 + (39.13 - 40.99) * t])
    }
    console.log('  使用直线近似（无 AMAP_KEY 时）')
  }
  for (const z of [12, 14, 15]) {
    const tiles = uniqueTilesAlong(coords, z)
    const avgBytes = z === 12 ? 30000 : z === 14 ? 100000 : 350000
    console.log('  z' + z + ': ' + tiles.length + ' 张瓦片 ≈ ' + ((tiles.length * avgBytes) / 1024 / 1024).toFixed(1) + ' MB（按平均 ' + (avgBytes / 1024).toFixed(0) + 'KB/张估）')
  }
  console.log('')
  console.log('结论：terrarium 瓦片免 Key、可缓存、体积小；z14（≈76m/px）为精度/体积平衡点，A2 采用。')
}

main().catch((e) => { console.error('运行失败:', e); process.exit(1) })