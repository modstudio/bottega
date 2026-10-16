// The suite budgets detect runtime regressions. The generous hung-suite bound
// separately stops a wedged child from hanging the gate indefinitely.
export const SUITE_RUNTIME_BUDGET_MS = 120_000
export const SUITE_CPU_BUDGET_MS = 180_000
export const HUNG_SUITE_TIMEOUT_MS = 900_000

export type RuntimeBudgetVerdict = 'within' | 'over-informational' | 'over-fatal'
export type RuntimeMeasure = 'wall' | 'cpu'
export type CommandCpuSample = { name: string; userMs: number; systemMs: number }
export type AttributedCommandCpu = { name: string; cpuMs: number; share: number }

const CHECK_LEG_NAMES = ['orchestrator', 'hub', 'hub/web', 'hub/deploy/site', 'retrieval'] as const

export type CheckLegName = (typeof CHECK_LEG_NAMES)[number]
type CheckShard = { index: number; total: number; value: string }
export type CheckArguments = {
  mode: 'static' | 'suite'
  only?: CheckLegName
  shard?: CheckShard
}
type ParsedArgument =
  | { kind: 'suite' }
  | { kind: 'only'; value: CheckLegName }
  | { kind: 'shard'; value: CheckShard }

function parseShard(value: string): CheckShard {
  const match = value.match(/^(\d+)\/(\d+)$/)
  if (!match) throw new Error(`invalid --shard=${value}; expected M/N`)
  const index = Number(match[1])
  const total = Number(match[2])
  if (total < 1 || index < 1 || index > total) {
    throw new Error(`invalid --shard=${value}; M and N must satisfy 1 <= M <= N`)
  }
  return { index, total, value }
}

function parseArgument(argument: string): ParsedArgument {
  if (argument === '--suite') return { kind: 'suite' }
  if (argument.startsWith('--only=')) {
    const value = argument.slice('--only='.length)
    if (!CHECK_LEG_NAMES.includes(value as CheckLegName)) {
      throw new Error(`invalid --only=${value}; expected one of ${CHECK_LEG_NAMES.join(', ')}`)
    }
    return { kind: 'only', value: value as CheckLegName }
  }
  if (argument.startsWith('--shard=')) {
    return { kind: 'shard', value: parseShard(argument.slice('--shard='.length)) }
  }
  throw new Error(`unknown check argument ${JSON.stringify(argument)}`)
}

function singleValue<T>(values: readonly T[], option: string): T | undefined {
  if (values.length > 1) throw new Error(`${option} may be provided only once`)
  return values[0]
}

export function parseCheckArguments(argv: readonly string[]): CheckArguments {
  const parsed = argv.map(parseArgument)
  const suite = singleValue(
    parsed.filter((argument) => argument.kind === 'suite'),
    '--suite',
  )
  const only = singleValue(
    parsed.filter((argument) => argument.kind === 'only').map((argument) => argument.value),
    '--only',
  )
  const shard = singleValue(
    parsed.filter((argument) => argument.kind === 'shard').map((argument) => argument.value),
    '--shard',
  )
  if (!suite && (only || shard)) throw new Error('--only and --shard require --suite')
  if (shard && only && only !== 'orchestrator') {
    throw new Error('--shard applies only to the orchestrator suite')
  }
  return {
    mode: suite ? 'suite' : 'static',
    ...(only ? { only } : {}),
    ...(shard ? { shard } : {}),
  }
}

export function selectedCheckLegs(options: CheckArguments): CheckLegName[] {
  return options.only ? [options.only] : [...CHECK_LEG_NAMES]
}

export function runsRootSuiteTests(options: CheckArguments): boolean {
  return (
    options.mode === 'suite' &&
    (!options.only || options.only === 'orchestrator') &&
    (!options.shard || options.shard.index === 1)
  )
}

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
