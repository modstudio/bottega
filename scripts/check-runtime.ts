// The suite budgets detect runtime regressions. The generous hung-suite bound
// separately stops a wedged child from hanging the gate indefinitely.
export const SUITE_RUNTIME_BUDGET_MS = 120_000
export const SUITE_CPU_BUDGET_MS = 180_000
export const HUNG_SUITE_TIMEOUT_MS = 900_000

export type RuntimeBudgetVerdict = 'within' | 'over-informational' | 'over-fatal'
export type RuntimeMeasure = 'wall' | 'cpu'
export type CommandCpuSample = { name: string; userMs: number; systemMs: number }
export type AttributedCommandCpu = { name: string; cpuMs: number; share: number }

export function attributeCommandCpu(commands: CommandCpuSample[]): {
  totalMs: number
  commands: AttributedCommandCpu[]
} {
  const commandCpu = commands.map((command) => ({
    name: command.name,
    cpuMs: command.userMs + command.systemMs,
  }))
  const totalMs = commandCpu.reduce((total, command) => total + command.cpuMs, 0)
  const attributed = commandCpu
    .map((command) => ({
      ...command,
      share: totalMs === 0 ? 0 : command.cpuMs / totalMs,
    }))
    .sort((left, right) => right.cpuMs - left.cpuMs || left.name.localeCompare(right.name))
  return { totalMs, commands: attributed }
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
