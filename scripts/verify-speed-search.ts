import {
  SPEED_SEARCH, buildSpeedGrid, coarseSpeedGrid, fineSpeedGrid, refineSpeedGrid, cheapestSpeed,
} from '../src/optimization/speedSearch'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}

function same(actual: number[], expected: number[]) {
  return actual.length === expected.length && actual.every((v, i) => Math.abs(v - expected[i]) < 1e-8)
}

assert(
  same(buildSpeedGrid(30, 47, 5), [30, 35, 40, 45, 47]),
  '粗扫应覆盖完整区间并保留非整步上限',
)
assert(
  same(fineSpeedGrid(47, 52), [42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52]),
  '1 km/h 加密应覆盖最优点左右 5 km/h',
)
assert(
  same(refineSpeedGrid(47, 48), [46, 46.2, 46.4, 46.6, 46.8, 47, 47.2, 47.4, 47.6, 47.8, 48]),
  '0.2 km/h 精修应覆盖最优点左右 1 km/h',
)
assert(
  same(coarseSpeedGrid(72), [30, 35, 40, 45, 50, 55, 60, 65, 70, 72]),
  '道路限速不是 5 的整数倍时也应评估上限',
)
assert(
  cheapestSpeed([
    { v: 60, cost: 100 },
    { v: 60.2, cost: 100 },
    { v: 59.8, cost: 100.1 },
  ])?.v === 60,
  '成本相同时应稳定选择较低速度',
)
assert(SPEED_SEARCH.coarseStepKmh === 5, '粗扫步长应为 5 km/h')
assert(SPEED_SEARCH.fineStepKmh === 1, '加密步长应为 1 km/h')
assert(SPEED_SEARCH.refineStepKmh === 0.2, '精修步长应为 0.2 km/h')

console.log('✓ speed search: 8 assertions passed')
