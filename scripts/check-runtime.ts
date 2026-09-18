// The suite budgets detect runtime regressions. The generous hung-suite bound
// separately stops a wedged child from hanging the gate indefinitely.
export const SUITE_RUNTIME_BUDGET_MS = 120_000
export const SUITE_CPU_BUDGET_MS = 180_000
export const HUNG_SUITE_TIMEOUT_MS = 900_000

export type RuntimeBudgetVerdict = 'within' | 'over-informational' | 'over-fatal'
export type RuntimeMeasure = 'wall' | 'cpu'

export function attributeCommandCpu(
  commands: Array<{ name: string; userMs: number; systemMs: number }>,
) {
  const totalMs = commands.reduce((total, command) => total + command.userMs + command.systemMs, 0)
  return commands
    .map((command) => {
      const cpuMs = command.userMs + command.systemMs
      return {
        name: command.name,
        cpuMs,
        share: totalMs === 0 ? 0 : cpuMs / totalMs,
      }
    })
    .sort((left, right) => right.cpuMs - left.cpuMs || left.name.localeCompare(right.name))
}

export function decideRuntimeBudget({
  elapsedMs,
  budgetMs,
  ci,
  measure,
}: {
  elapsedMs: number
  budgetMs: number
  ci: boolean
  measure: RuntimeMeasure
}): RuntimeBudgetVerdict {
  if (elapsedMs <= budgetMs) return 'within'
  return ci && measure === 'cpu' ? 'over-fatal' : 'over-informational'
}
