/**
 * 经济车速分层搜索工具。
 *
 * 搜索策略：
 *   1) 在完整可行区间内按 5 km/h 粗扫；
 *   2) 在最优点左右 5 km/h 内按 1 km/h 加密；
 *   3) 在新的最优点左右 1 km/h 内按 0.2 km/h 精修。
 *
 * 不假设函数严格单峰：第一层始终覆盖完整区间，因此能在粗网格上识别
 * 多个候选谷底并选择成本最低者；后两层只负责局部精度提升。
 */

export const SPEED_SEARCH = {
  minKmh: 30,
  coarseStepKmh: 5,
  fineStepKmh: 1,
  refineStepKmh: 0.2,
  fineHalfWidthKmh: 5,
  refineHalfWidthKmh: 1,
} as const

const EPS = 1e-8

function decimalsForStep(step: number): number {
  if (Math.abs(step - Math.round(step)) < EPS) return 0
  if (Math.abs(step * 10 - Math.round(step * 10)) < EPS) return 1
  return 2
}

function roundTo(n: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round((n + Number.EPSILON) * factor) / factor
}

/**
 * 生成闭区间 [lo, hi] 内的速度网格，并保证两端点被包含。
 * 例如 buildSpeedGrid(40, 47, 5) => [40, 45, 47]。
 */
export function buildSpeedGrid(lo: number, hi: number, step: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(step) || step <= 0) return []
  if (hi + EPS < lo) return []

  const decimals = decimalsForStep(step)
  const out: number[] = []
  const first = Math.ceil((lo - EPS) / step) * step
  for (let v = first; v <= hi + EPS; v += step) out.push(roundTo(v, decimals))
  out.push(roundTo(lo, decimals), roundTo(hi, decimals))
  return [...new Set(out)].filter((v) => v >= lo - EPS && v <= hi + EPS).sort((a, b) => a - b)
}

/** 第一层：覆盖整个可行速度区间。cap 不是 5 的整数倍时也保留 cap 边界。 */
export function coarseSpeedGrid(capKmh: number): number[] {
  return buildSpeedGrid(
    Math.min(SPEED_SEARCH.minKmh, capKmh),
    capKmh,
    SPEED_SEARCH.coarseStepKmh,
  )
}

/** 第二层：围绕粗网格最优车速左右 5 km/h，按 1 km/h 加密。 */
export function fineSpeedGrid(bestKmh: number, capKmh: number): number[] {
  const lo = Math.max(SPEED_SEARCH.minKmh, bestKmh - SPEED_SEARCH.fineHalfWidthKmh)
  const hi = Math.min(capKmh, bestKmh + SPEED_SEARCH.fineHalfWidthKmh)
  return buildSpeedGrid(lo, hi, SPEED_SEARCH.fineStepKmh)
}

/** 第三层：围绕 1 km/h 网格最优车速左右 1 km/h，按 0.2 km/h 精修。 */
export function refineSpeedGrid(bestKmh: number, capKmh: number): number[] {
  const lo = Math.max(SPEED_SEARCH.minKmh, bestKmh - SPEED_SEARCH.refineHalfWidthKmh)
  const hi = Math.min(capKmh, bestKmh + SPEED_SEARCH.refineHalfWidthKmh)
  return buildSpeedGrid(lo, hi, SPEED_SEARCH.refineStepKmh)
}

/** 从评估结果中取成本最低的速度；成本相同时优先较低速度。 */
export function cheapestSpeed<T extends { v: number; cost: number }>(options: T[]): T | null {
  let best: T | null = null
  for (const option of options) {
    if (!Number.isFinite(option.cost)) continue
    if (!best || option.cost < best.cost - EPS || (Math.abs(option.cost - best.cost) <= EPS && option.v < best.v)) {
      best = option
    }
  }
  return best
}
