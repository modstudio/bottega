import { type Shard as CheckShard, parseShard } from '../shared/shard.ts'
import { CHECK_LEGS, STATIC_OMIT_GROUPS } from './check-plan.ts'

// The suite budgets detect runtime regressions. The CI suite CPU budget sits above
// the shard-to-shard variance of shared CI runners, so only a large regression
// fails it. The static budget only reports. The generous hung-suite bound
// separately stops a wedged child from hanging the gate indefinitely.
export const SUITE_RUNTIME_BUDGET_MS = 120_000
export const SUITE_CPU_BUDGET_MS = 300_000
const STATIC_CPU_BUDGET_MS = 180_000
export const HUNG_SUITE_TIMEOUT_MS = 900_000

export function cpuBudgetMs(mode: CheckArguments['mode']): number {
  return mode === 'suite' ? SUITE_CPU_BUDGET_MS : STATIC_CPU_BUDGET_MS
}

export type RuntimeBudgetVerdict = 'within' | 'over-informational' | 'over-fatal'
export type RuntimeMeasure = 'wall' | 'cpu'
export type CommandCpuSample = { name: string; userMs: number; systemMs: number }
export type AttributedCommandCpu = { name: string; cpuMs: number; share: number }
export type InstalledDependencyState = {
  lockfileHash: string | null
  nodeModulesPresent: boolean
}
export type DependencyInstallFacts = {
  ci: boolean
  linkedWorktree: boolean
  workerRun: boolean
}
export type DependencyInstallMode = 'normal' | 'worker-offline'

/** Only an orchestrator worker uses the registry-free install path. */
export function dependencyInstallMode(facts: DependencyInstallFacts): DependencyInstallMode {
  return facts.workerRun ? 'worker-offline' : 'normal'
}

/** Decide whether the provisioned dependency tree still belongs to this lockfile. */
export function installNeeded(
  lockfileHash: string,
  installedState: InstalledDependencyState,
): boolean {
  return !installedState.nodeModulesPresent || installedState.lockfileHash !== lockfileHash
}

const CHECK_LEG_NAMES = CHECK_LEGS.map((leg) => leg.name)
type CheckLegName = (typeof CHECK_LEGS)[number]['name']
type StaticOmitGroup = keyof typeof STATIC_OMIT_GROUPS
type CheckOnly = CheckLegName | 'root'
export type CheckArguments = {
  mode: 'static' | 'suite'
  only?: CheckOnly
  shard?: CheckShard
  omit: StaticOmitGroup[]
}
type ParsedArgument =
  | { kind: 'suite' }
  | { kind: 'only'; value: CheckOnly }
  | { kind: 'shard'; value: CheckShard }
  | { kind: 'omit'; value: StaticOmitGroup }

function parseArgument(argument: string): ParsedArgument {
  if (argument === '--suite') return { kind: 'suite' }
  if (argument.startsWith('--only=')) {
    const value = argument.slice('--only='.length)
    if (value !== 'root' && !CHECK_LEG_NAMES.includes(value as CheckLegName)) {
      throw new Error(
        `invalid --only=${value}; expected one of ${CHECK_LEG_NAMES.join(', ')}, root`,
      )
    }
    return { kind: 'only', value: value as CheckOnly }
  }
  if (argument.startsWith('--shard=')) {
    const value = argument.slice('--shard='.length)
    try {
      return { kind: 'shard', value: parseShard(value) }
    } catch (error) {
      throw new Error(`invalid --shard=${value}; ${error instanceof Error ? error.message : error}`)
    }
  }
  if (argument.startsWith('--omit=')) {
    const value = argument.slice('--omit='.length)
    if (!(value in STATIC_OMIT_GROUPS)) {
      throw new Error(
        `invalid --omit=${value}; expected one of ${Object.keys(STATIC_OMIT_GROUPS).join(', ')}`,
      )
    }
    return { kind: 'omit', value: value as StaticOmitGroup }
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
  const omit = parsed
    .filter((argument) => argument.kind === 'omit')
    .map((argument) => argument.value)
  if (!suite && (only || shard)) throw new Error('--only and --shard require --suite')
  if (suite && omit.length > 0) throw new Error('--omit applies only to the static check')
  if (shard && only && only !== 'orchestrator') {
    throw new Error('--shard applies only to the orchestrator suite')
  }
  return {
    mode: suite ? 'suite' : 'static',
    ...(only ? { only } : {}),
    ...(shard ? { shard } : {}),
    omit,
  }
}

export function selectedCheckLegs(options: CheckArguments): CheckLegName[] {
  if (options.only === 'root') return []
  return options.only ? [options.only] : [...CHECK_LEG_NAMES]
}

export function runsRootSuiteTests(options: CheckArguments): boolean {
  return options.mode === 'suite' && options.only === 'root'
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
