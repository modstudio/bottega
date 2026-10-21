export function decideTimingGrowthPublication({
  growth,
  longPoleCount,
  ci,
}: {
  growth: 'compare' | 'skip-sharded'
  longPoleCount: number
  ci: boolean
}):
  | { kind: 'compare'; longPolesPassed: boolean; reportOnly: boolean }
  | { kind: 'finish-sharded'; passed: boolean; reportOnly: boolean } {
  const reportOnly = ci && longPoleCount > 0
  const longPolesPassed = longPoleCount === 0 || reportOnly
  if (growth === 'skip-sharded') {
    return { kind: 'finish-sharded', passed: longPolesPassed, reportOnly }
  }
  return { kind: 'compare', longPolesPassed, reportOnly }
}
