import { fileURLToPath } from 'node:url'
import { decideGateOutcome, type GateStepResult } from './check-outcome'
import {
  attributeCommandCpu,
  type CommandCpuSample,
  decideRuntimeBudget,
  HUNG_SUITE_TIMEOUT_MS,
  SUITE_CPU_BUDGET_MS,
  SUITE_RUNTIME_BUDGET_MS,
} from './check-runtime'
import { resolveLandingBase } from './landing-base'

type Command = { cwd: string; argv: string[] }
type Leg = { name: string; commands: Command[] }
type LegResult = GateStepResult & { tail: string[] }
type StaticCheck = { name: string; argv: string[] }

const root = fileURLToPath(new URL('..', import.meta.url))
const checkStartedAt = performance.now()
const KILLED_CHILD_EXIT_TIMEOUT_MS = 5_000

const activeChildren = new Set<Bun.Subprocess>()
const trackedExits = new Map<Bun.Subprocess, Promise<void>>()
const collectedChildren = new WeakSet<Bun.Subprocess>()
const commandCpu: CommandCpuSample[] = []
let excludedGateWaitMs = 0
let runtimeDeadline: ReturnType<typeof setTimeout>
let summaryPrinted = false

function describeCommand(argv: string[], cwd = root) {
  const location = cwd.startsWith(root) ? cwd.slice(root.length).replace(/\/$/, '') || '.' : cwd
  const command = argv.map((argument) => argument.replace(root, '')).join(' ')
  return `${location}: ${command}`
}

function collectCpu(
  name: string,
  cpuTime: { user: number | bigint; system: number | bigint } | undefined,
) {
  if (!cpuTime) return
  commandCpu.push({
    name,
    userMs: Number(cpuTime.user) / 1_000,
    systemMs: Number(cpuTime.system) / 1_000,
  })
}

function collectChildCpu(child: Bun.Subprocess, name: string) {
  if (collectedChildren.has(child)) return
  collectedChildren.add(child)
  collectCpu(name, child.resourceUsage()?.cpuTime)
  activeChildren.delete(child)
}

function printSummary(): { elapsedMs: number; cpuMs: number } | undefined {
  if (summaryPrinted) return undefined
  summaryPrinted = true
  const elapsedMs = performance.now() - checkStartedAt - excludedGateWaitMs
  const attributed = attributeCommandCpu(commandCpu)
  console.log(
    `suite runtime: ${(elapsedMs / 1000).toFixed(2)}s / ${(SUITE_RUNTIME_BUDGET_MS / 1000).toFixed(0)}s budget`,
  )
  console.log(
    `suite cpu: ${(attributed.totalMs / 1000).toFixed(2)}s / ${(SUITE_CPU_BUDGET_MS / 1000).toFixed(0)}s budget`,
  )
  console.log('suite cpu by command:')
  for (const command of attributed.commands) {
    console.log(
      `  ${command.cpuMs.toFixed(2)}ms ${(command.share * 100).toFixed(2)}% ${command.name}`,
    )
  }
  if (excludedGateWaitMs)
    console.log(`gate admission wait excluded: ${(excludedGateWaitMs / 1000).toFixed(2)}s`)
  return { elapsedMs, cpuMs: attributed.totalMs }
}

process.on('exit', printSummary)

async function expireRuntimeBudget() {
  console.error(
    `suite runtime exceeded the ${(HUNG_SUITE_TIMEOUT_MS / 1000).toFixed(0)}s hung-suite limit`,
  )
  for (const child of activeChildren) child.kill('SIGTERM')
  await Bun.sleep(1_000)
  const killedChildren = [...activeChildren]
  for (const child of killedChildren) child.kill('SIGKILL')
  await Promise.race([
    Promise.allSettled(killedChildren.map((child) => trackedExits.get(child)!)),
    Bun.sleep(KILLED_CHILD_EXIT_TIMEOUT_MS),
  ])
  process.exit(1)
}

function armRuntimeDeadline() {
  clearTimeout(runtimeDeadline)
  const deadline = checkStartedAt + HUNG_SUITE_TIMEOUT_MS + excludedGateWaitMs
  runtimeDeadline = setTimeout(expireRuntimeBudget, Math.max(0, deadline - performance.now()))
}

armRuntimeDeadline()

function track(child: Bun.Subprocess, name: string) {
  activeChildren.add(child)
  const trackedExit = child.exited.then(
    () => collectChildCpu(child, name),
    () => collectChildCpu(child, name),
  )
  trackedExits.set(child, trackedExit)
  return child
}

const legs: Leg[] = [
  {
    name: 'orchestrator',
    commands: [
      { cwd: `${root}orchestrator`, argv: ['bun', 'run', 'typecheck'] },
      // The unit gate runs once under the shared host-load hold.
      { cwd: `${root}orchestrator`, argv: ['bun', 'run', 'test:gate'] },
    ],
  },
  {
    name: 'hub',
    commands: [
      { cwd: `${root}hub`, argv: ['bun', 'run', 'typecheck'] },
      { cwd: `${root}hub`, argv: ['bun', 'run', 'test'] },
    ],
  },
  {
    name: 'hub/web',
    commands: [
      { cwd: `${root}hub/web`, argv: ['bun', 'run', 'typecheck'] },
      { cwd: `${root}hub/web`, argv: ['bun', 'run', 'test'] },
      { cwd: `${root}hub/web`, argv: ['bun', 'run', 'build'] },
    ],
  },
  {
    name: 'retrieval',
    commands: [
      { cwd: `${root}retrieval`, argv: ['bun', 'run', 'typecheck'] },
      { cwd: `${root}retrieval`, argv: ['bun', 'run', 'test'] },
    ],
  },
]

async function inherit(argv: string[], cwd = root) {
  const child = track(
    Bun.spawn(argv, { cwd, stdout: 'inherit', stderr: 'inherit' }),
    describeCommand(argv, cwd),
  )
  return child.exited
}

function staticCheck(name: string, extra: string[] = []): StaticCheck {
  return { name, argv: ['bun', `${root}${name}`, ...extra] }
}

async function recordGateStep(check: StaticCheck): Promise<GateStepResult> {
  return { name: check.name, exitCode: await inherit(check.argv) }
}

function qualityBaseArgument() {
  if (!process.env.CI) return '--staged'
  const base = resolveLandingBase(root, 'quality ratchet')
  collectCpu(describeCommand(base.command), base.cpuTime)
  return `--base=${base.commit}`
}

async function pump(
  stream: ReadableStream<Uint8Array>,
  name: string,
  tail: string[],
  error: boolean,
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    pending += decoder.decode(chunk.value, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop()!
    for (const line of lines) {
      const gateWait = name === 'orchestrator' && line.match(/^held (\d+)ms for host load /)
      if (gateWait) {
        excludedGateWaitMs += Number(gateWait[1])
        armRuntimeDeadline()
      }
      const prefixed = `[${name}] ${line}`
      ;(error ? console.error : console.log)(prefixed)
      tail.push(prefixed)
      if (tail.length > 40) tail.shift()
    }
  }
  pending += decoder.decode()
  if (pending) {
    const prefixed = `[${name}] ${pending}`
    ;(error ? console.error : console.log)(prefixed)
    tail.push(prefixed)
    if (tail.length > 40) tail.shift()
  }
}

async function runLeg(leg: Leg): Promise<LegResult> {
  const tail: string[] = []
  for (const command of leg.commands) {
    const child = track(
      Bun.spawn(command.argv, { cwd: command.cwd, stdout: 'pipe', stderr: 'pipe' }),
      describeCommand(command.argv, command.cwd),
    )
    const readers = [
      pump(child.stdout, leg.name, tail, false),
      pump(child.stderr, leg.name, tail, true),
    ]
    const exitCode = await child.exited
    await Promise.all(readers)
    if (exitCode !== 0) return { name: leg.name, exitCode, tail }
  }
  return { name: leg.name, exitCode: 0, tail }
}

function printFailedLegTails(results: LegResult[]) {
  const failed = results.filter((result) => result.exitCode !== 0)
  if (!failed.length) return
  for (const result of failed) {
    console.error(`\n[${result.name}] failing leg tail (exit ${result.exitCode})`)
    for (const line of result.tail) console.error(line)
  }
}

if ((await inherit(['bun', 'install', '--silent'])) !== 0) process.exit(1)

if ((await inherit([`${root}node_modules/.bin/biome`, 'ci', '.'])) !== 0) process.exit(1)

if (
  (await inherit([
    // Every .githooks test must be named here. The list is explicit rather than a
    // glob so this runs in a fixed order before the legs, and the cost of that is
    // that an unnamed hook test is not gated at all - which reports safety it is
    // not providing.
    'bun',
    'test',
    './scripts/check-machine-state.test.ts',
    './scripts/check-runtime.test.ts',
    './scripts/check-outcome.test.ts',
    './scripts/check-cascade-preservation.test.ts',
    './scripts/check-outbox-payload-contracts.test.ts',
    './scripts/postgres-migration-rls.test.ts',
    './scripts/check-test-placement.test.ts',
    './scripts/check-file-ceiling.test.ts',
    './scripts/check-cognitive-ceiling.test.ts',
    './scripts/check-harness-mirror.test.ts',
    './scripts/check-canon-drift.test.ts',
    './scripts/check-self-spawn.test.ts',
    './scripts/check-source-root.test.ts',
    './scripts/build-binary.test.ts',
    './scripts/build-release.test.ts',
    './scripts/build-release-artifacts.test.ts',
    './scripts/publish-release.test.ts',
    './release/dispatch.test.ts',
    './shared/self-spawn.test.ts',
    './scripts/quality/dead-code.test.ts',
    './scripts/architecture.test.ts',
    './scripts/import-scanner.test.ts',
    './scripts/quality/no-expect.test.ts',
    './shared/ratchet.test.ts',
    './scripts/quality/ceiling-decision.test.ts',
    './scripts/quality/test-timing-decision.test.ts',
    './shared/git.test.ts',
    './shared/orch-contract.test.ts',
    './shared/interval.test.ts',
    './shared/trackers-protocols.test.ts',
  ])) !== 0
)
  process.exit(1)

const results = await Promise.all(
  legs.map((leg) =>
    runLeg({
      name: leg.name,
      commands: leg.commands,
    }),
  ),
)
printFailedLegTails(results)
const gateSteps: GateStepResult[] = [...results]
const staticChecks: StaticCheck[] = [
  { name: 'project checks', argv: ['bun', `${root}orchestrator/scripts/check-projects.ts`] },
  staticCheck('scripts/check-machine-state.ts'),
  staticCheck('scripts/check-cascade-preservation.ts'),
  staticCheck('scripts/check-postgres-migrations.ts'),
  staticCheck('scripts/check-postgres-array-bindings.ts'),
  staticCheck('scripts/check-outbox-payload-contracts.ts'),
  staticCheck('scripts/check-record-migrations-apply.ts'),
  staticCheck('scripts/check-hosted-hub-server-boundary.ts'),
  staticCheck('scripts/check-architecture.ts'),
  staticCheck('scripts/check-review-boundary.ts'),
  staticCheck('scripts/check-outcome-boundary.ts'),
  staticCheck('scripts/check-contract-boundary.ts'),
  staticCheck('scripts/check-evidence-boundary.ts'),
  staticCheck('scripts/check-git-environment-spawn.ts'),
  staticCheck('scripts/check-self-spawn.ts'),
  staticCheck('scripts/check-source-root.ts'),
  staticCheck('scripts/check-launchd-templates.ts'),
  staticCheck('scripts/check-gitleaks.ts'),
  staticCheck('scripts/check-write-transaction-site.ts'),
  staticCheck('scripts/check-file-ceiling.ts'),
  staticCheck('scripts/check-cognitive-ceiling.ts'),
  staticCheck('scripts/check-test-fixtures.ts'),
  staticCheck('scripts/check-test-placement.ts'),
  staticCheck('scripts/check-test-spawns.ts'),
  staticCheck('scripts/check-dead-code.ts'),
  staticCheck('scripts/check-brand.ts'),
  staticCheck('scripts/check-harness-mirror.ts'),
  staticCheck('scripts/check-canon-drift.ts'),
  staticCheck('scripts/generate-recipe-schema.ts', ['--check']),
  staticCheck('orchestrator/scripts/check-pack-budget.ts'),
  staticCheck('orchestrator/scripts/check-canon-lint.ts'),
]
for (const check of staticChecks) gateSteps.push(await recordGateStep(check))

let qualityMode: string
try {
  qualityMode = qualityBaseArgument()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
gateSteps.push(
  await recordGateStep(staticCheck('scripts/quality/check-no-expect.ts', [qualityMode])),
)

clearTimeout(runtimeDeadline)
const summary = printSummary()
if (!summary) throw new Error('suite summary printed before budget checks')
const { elapsedMs, cpuMs } = summary
const runtimeBudgetVerdict = decideRuntimeBudget({
  elapsedMs,
  budgetMs: SUITE_RUNTIME_BUDGET_MS,
  ci: Boolean(process.env.CI),
  measure: 'wall',
})
if (runtimeBudgetVerdict === 'over-informational') {
  console.log(
    'suite runtime budget is informational because wall clock cannot separate a slower suite from a busier machine',
  )
}
const cpuBudgetVerdict = decideRuntimeBudget({
  elapsedMs: cpuMs,
  budgetMs: SUITE_CPU_BUDGET_MS,
  ci: Boolean(process.env.CI),
  measure: 'cpu',
})
if (cpuBudgetVerdict === 'over-informational') {
  console.log('suite CPU budget is informational locally')
}
if (cpuBudgetVerdict === 'over-fatal') {
  console.error(
    `suite CPU budget exceeded by ${((cpuMs - SUITE_CPU_BUDGET_MS) / 1000).toFixed(2)}s`,
  )
}
const gate = decideGateOutcome(gateSteps)
if (gate.failures.length > 0) {
  console.error('gate failures:')
  for (const name of gate.failures) console.error(name)
}
if (cpuBudgetVerdict === 'over-fatal' || gate.exitCode !== 0) process.exit(1)
