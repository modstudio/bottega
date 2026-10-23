import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CHECK_EXECUTION_FILE_ENV,
  type CheckExecutionRecord,
  UNIT_TEST_CHECK_CATEGORY,
} from '../shared/check-execution'
import { decideGateOutcome, type GateStepResult } from './check-outcome.ts'
import { CHECK_LEGS, STATIC_OMIT_GROUPS } from './check-plan.ts'
import {
  attributeCommandCpu,
  type CheckArguments,
  type CommandCpuSample,
  cpuBudgetMs,
  decideRuntimeBudget,
  dependencyInstallMode,
  HUNG_SUITE_TIMEOUT_MS,
  installNeeded,
  parseCheckArguments,
  runsRootSuiteTests,
  SUITE_CPU_BUDGET_MS,
  SUITE_RUNTIME_BUDGET_MS,
  selectedCheckLegs,
} from './check-runtime'
import { resolveLandingBase } from './landing-base'
import { readRemainingReport } from './remaining-report.ts'

type Command = { cwd: string; argv: string[]; category?: string }
type Leg = { name: (typeof CHECK_LEGS)[number]['name']; typecheck: Command; suite: Command[] }
type RunnableLeg = { name: string; commands: Command[] }
type LegResult = GateStepResult & { tail: string[] }
type StaticCheck = { name: string; argv: string[]; category?: string; reportPath?: string }
type ExecutionObservation = Pick<StaticCheck, 'category' | 'reportPath'> & { check?: string }

const root = fileURLToPath(new URL('..', import.meta.url))
const checkArguments: CheckArguments = (() => {
  try {
    return parseCheckArguments(Bun.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
})()
const checkStartedAt = performance.now()
const KILLED_CHILD_EXIT_TIMEOUT_MS = 5_000
const executionFile = process.env[CHECK_EXECUTION_FILE_ENV]
const reportDirectory = executionFile ? mkdtempSync(join(tmpdir(), 'check-reports-')) : undefined

const activeChildren = new Set<Bun.Subprocess>()
const trackedExits = new Map<Bun.Subprocess, Promise<void>>()
const collectedChildren = new WeakSet<Bun.Subprocess>()
const childMeasurements = new WeakMap<
  Bun.Subprocess,
  ExecutionObservation & { name: string; startedAt: number }
>()
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

function appendExecution(record: CheckExecutionRecord) {
  if (!executionFile) return
  try {
    appendFileSync(executionFile, `${JSON.stringify(record)}\n`)
  } catch (error) {
    console.warn(`check execution record could not be written: ${String(error)}`)
  }
}

function collectChild(child: Bun.Subprocess, exitCode: number) {
  if (collectedChildren.has(child)) return
  collectedChildren.add(child)
  const measurement = childMeasurements.get(child)
  if (!measurement) throw new Error('child measurement was not registered')
  const cpuTime = child.resourceUsage()?.cpuTime
  collectCpu(measurement.name, cpuTime)
  const remaining = readRemainingReport(measurement.reportPath)
  appendExecution({
    check: measurement.check ?? measurement.name,
    ...(measurement.category ? { category: measurement.category } : {}),
    wallMs: performance.now() - measurement.startedAt,
    ...(cpuTime ? { cpuMs: (Number(cpuTime.user) + Number(cpuTime.system)) / 1_000 } : {}),
    exitCode,
    ...(remaining === undefined ? {} : { remaining }),
  })
  activeChildren.delete(child)
}

function printSummary(): { elapsedMs: number; cpuMs: number } | undefined {
  if (summaryPrinted) return undefined
  summaryPrinted = true
  const elapsedMs = performance.now() - checkStartedAt - excludedGateWaitMs
  const attributed = attributeCommandCpu(commandCpu)
  console.log(
    `${checkArguments.mode} runtime: ${(elapsedMs / 1000).toFixed(2)}s / ${(SUITE_RUNTIME_BUDGET_MS / 1000).toFixed(0)}s budget`,
  )
  console.log(
    `${checkArguments.mode} cpu: ${(attributed.totalMs / 1000).toFixed(2)}s / ${(cpuBudgetMs(checkArguments.mode) / 1000).toFixed(0)}s budget`,
  )
  console.log(`${checkArguments.mode} cpu by command:`)
  for (const command of attributed.commands) {
    console.log(
      `  ${command.cpuMs.toFixed(2)}ms ${(command.share * 100).toFixed(2)}% ${command.name}`,
    )
  }
  if (excludedGateWaitMs)
    console.log(`gate admission wait excluded: ${(excludedGateWaitMs / 1000).toFixed(2)}s`)
  return { elapsedMs, cpuMs: attributed.totalMs }
}

process.on('exit', () => {
  if (reportDirectory) rmSync(reportDirectory, { recursive: true, force: true })
  printSummary()
})

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

function track(
  child: Bun.Subprocess,
  name: string,
  observation: ExecutionObservation = {},
  startedAt = performance.now(),
) {
  activeChildren.add(child)
  childMeasurements.set(child, { name, startedAt, ...observation })
  const trackedExit = child.exited.then(
    (exitCode) => collectChild(child, exitCode),
    () => collectChild(child, -1),
  )
  trackedExits.set(child, trackedExit)
  return child
}

const legs: Leg[] = CHECK_LEGS.map((leg) => ({
  name: leg.name,
  typecheck: { cwd: `${root}${leg.directory}`, argv: [...leg.typecheck] },
  suite: leg.suite.map(({ argv, unitTests }) => ({
    cwd: `${root}${leg.directory}`,
    ...(unitTests ? { category: UNIT_TEST_CHECK_CATEGORY } : {}),
    argv: [
      ...argv,
      ...(leg.name === 'orchestrator' && checkArguments.shard
        ? [`--shard=${checkArguments.shard.value}`]
        : []),
    ],
  })),
}))

async function inherit(argv: string[], cwd = root, observation: ExecutionObservation = {}) {
  const startedAt = performance.now()
  const child = track(
    Bun.spawn(argv, { cwd, stdout: 'inherit', stderr: 'inherit' }),
    describeCommand(argv, cwd),
    observation,
    startedAt,
  )
  return child.exited
}

function staticCheck(
  name: string,
  extra: string[] = [],
  category?: string,
  reportsRemaining = false,
): StaticCheck {
  const reportPath =
    reportsRemaining && reportDirectory
      ? join(reportDirectory, `${crypto.randomUUID()}.json`)
      : undefined
  return {
    name,
    argv: ['bun', `${root}${name}`, ...extra, ...(reportPath ? [`--report=${reportPath}`] : [])],
    category,
    reportPath,
  }
}

async function recordGateStep(check: StaticCheck): Promise<GateStepResult> {
  return {
    name: check.name,
    exitCode: await inherit(check.argv, root, {
      check: check.name,
      category: check.category,
      reportPath: check.reportPath,
    }),
  }
}

function qualityBaseArgument() {
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

async function runLeg(leg: RunnableLeg): Promise<LegResult> {
  const tail: string[] = []
  for (const command of leg.commands) {
    const startedAt = performance.now()
    const child = track(
      Bun.spawn(command.argv, { cwd: command.cwd, stdout: 'pipe', stderr: 'pipe' }),
      describeCommand(command.argv, command.cwd),
      { category: command.category },
      startedAt,
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

const lockfilePath = join(root, 'bun.lock')
const nodeModulesPath = join(root, 'node_modules')
const installedStatePath = join(nodeModulesPath, '.check-lockfile')

async function installDependencies() {
  const installMode = dependencyInstallMode({
    ci: Boolean(process.env.CI),
    linkedWorktree: !lstatSync(join(root, '.git')).isDirectory(),
    workerRun: Boolean(process.env.ORCH_RUN_ID || process.env.ORCH_DEPTH),
  })
  if (installMode === 'normal') return inherit(['bun', 'install', '--silent'])

  const verify = ['bun', 'install', '--offline', '--frozen-lockfile', '--dry-run', '--silent']
  if ((await inherit(verify)) !== 0) return 1

  const lockfileHash = createHash('sha256').update(readFileSync(lockfilePath)).digest('hex')
  const installedState = {
    lockfileHash: existsSync(installedStatePath)
      ? readFileSync(installedStatePath, 'utf8').trim()
      : null,
    nodeModulesPresent: existsSync(nodeModulesPath),
  }
  if (!installNeeded(lockfileHash, installedState)) return 0

  const exitCode = await inherit(['bun', 'install', '--offline', '--frozen-lockfile', '--silent'])
  if (exitCode === 0) writeFileSync(installedStatePath, `${lockfileHash}\n`)
  return exitCode
}

if ((await installDependencies()) !== 0) process.exit(1)

const dependencyAuditExitCode = await inherit(['bun', 'scripts/check-dependency-audit.ts'], root, {
  check: 'dependency audit',
})
if (dependencyAuditExitCode !== 0) process.exit(1)

const rootTests = [
  // Every .githooks test must be named here. The list is explicit rather than a
  // glob so this runs in a fixed order, and the cost of that is
  // that an unnamed hook test is not gated at all - which reports safety it is
  // not providing.
  'bun',
  'test',
  './scripts/check-machine-state.test.ts',
  './scripts/check-legacy-names.test.ts',
  './scripts/check-docker-workspaces.test.ts',
  './scripts/check-dependency-audit.test.ts',
  './scripts/check-runtime.test.ts',
  './scripts/check-ci-workflow.test.ts',
  './scripts/check-storybook.test.ts',
  './scripts/check-outcome.test.ts',
  './scripts/check-gitleaks-plan.test.ts',
  './scripts/check-cascade-preservation.test.ts',
  './scripts/identity-inventory.test.ts',
  './scripts/check-outbox-payload-contracts.test.ts',
  './scripts/postgres-migration-rls.test.ts',
  './scripts/check-test-placement.test.ts',
  './scripts/check-test-reach.test.ts',
  './shared/change-view.test.ts',
  './orchestrator/src/ratchet/biome-adapter.test.ts',
  './orchestrator/src/ratchet/ratchet-plan.test.ts',
  './scripts/check-file-ceiling.test.ts',
  './scripts/command-descriptions.test.ts',
  './scripts/command-reference.test.ts',
  './scripts/check-cognitive-ceiling.test.ts',
  './scripts/check-harness-mirror.test.ts',
  './scripts/check-canon-drift.test.ts',
  './scripts/check-postgres-array-bindings.test.ts',
  './scripts/check-self-spawn.test.ts',
  './scripts/check-source-root.test.ts',
  './scripts/build-binary.test.ts',
  './scripts/build-release.test.ts',
  './scripts/build-release-artifacts.test.ts',
  './scripts/publish-release.test.ts',
  './cli/dispatch.test.ts',
  './cli/routes.test.ts',
  './cli/legacy-calls.test.ts',
  './shared/self-spawn.test.ts',
  './scripts/quality/dead-code.test.ts',
  './scripts/architecture.test.ts',
  './scripts/architecture-hub-packages.test.ts',
  './scripts/import-scanner.test.ts',
  './shared/test-substance/test-substance.test.ts',
  './shared/test-substance/no-assertion.test.ts',
  './shared/test-substance/test-substance-php.test.ts',
  './shared/test-substance/self-comparison.test.ts',
  './shared/ratchet.test.ts',
  './shared/check-execution.test.ts',
  './scripts/quality/test-timing-decision.test.ts',
  './shared/file-kind.test.ts',
  './shared/git.test.ts',
  './shared/orch-contract.test.ts',
  './shared/interval.test.ts',
  './shared/trackers-protocols.test.ts',
  './shared/shard.test.ts',
  './scripts/test-focused.test.ts',
  './scripts/check-sql-literal-schema.test.ts',
  './scripts/check-hosted-sql-schema.test.ts',
]

const selected = new Set(selectedCheckLegs(checkArguments))
const results = await Promise.all(
  legs
    .filter((leg) => selected.has(leg.name))
    .map((leg) =>
      runLeg({
        name: leg.name,
        commands: checkArguments.mode === 'static' ? [leg.typecheck] : leg.suite,
      }),
    ),
)
printFailedLegTails(results)
const gateSteps: GateStepResult[] = [...results]
if (checkArguments.mode === 'suite' && runsRootSuiteTests(checkArguments)) {
  gateSteps.push({
    name: 'root tests',
    exitCode: await inherit(rootTests, root, { category: UNIT_TEST_CHECK_CATEGORY }),
  })
}

if (checkArguments.mode === 'static') {
  gateSteps.push({
    name: 'Biome',
    exitCode: await inherit([`${root}node_modules/.bin/biome`, 'ci', '.']),
  })
  let qualityMode: string
  try {
    qualityMode = qualityBaseArgument()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  const staticChecks: StaticCheck[] = [
    { name: 'project checks', argv: ['bun', `${root}orchestrator/scripts/check-projects.ts`] },
    {
      name: 'orchestrator identity inventory',
      argv: ['bun', `${root}scripts/check-identity-inventory.ts`, qualityMode],
    },
    { name: 'SQL literal schema', argv: ['bun', `${root}scripts/check-sql-literal-schema.ts`] },
    { name: 'hosted SQL schema', argv: ['bun', `${root}scripts/check-hosted-sql-schema.ts`] },
    staticCheck('scripts/check-machine-state.ts'),
    staticCheck('scripts/check-cascade-preservation.ts'),
    staticCheck('scripts/check-postgres-migrations.ts'),
    staticCheck('scripts/check-postgres-array-bindings.ts'),
    staticCheck('scripts/check-outbox-payload-contracts.ts'),
    staticCheck('scripts/check-record-migrations-apply.ts'),
    staticCheck('scripts/check-hosted-hub-server-boundary.ts'),
    staticCheck('scripts/check-docker-workspaces.ts'),
    staticCheck('scripts/check-hub-packages.ts'),
    staticCheck('scripts/check-hub-ui-styles.ts'),
    staticCheck('scripts/check-storybook.ts'),
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
    staticCheck('scripts/check-branch-ref-mutation-site.ts'),
    staticCheck('scripts/check-command-descriptions.ts'),
    staticCheck('scripts/reference.ts'),
    staticCheck('scripts/check-file-ceiling.ts', [], 'file-length', true),
    staticCheck('scripts/check-cognitive-ceiling.ts', [qualityMode], 'cognitive-complexity', true),
    {
      name: 'function length and naming ratchet',
      argv: [
        'bun',
        `${root}orchestrator/src/cli/orch.ts`,
        'ratchet',
        '--format',
        'biome',
        qualityMode,
        '--support',
        'biome.jsonc',
        '--support',
        'hub/web/lint',
        '--',
        `${root}node_modules/.bin/biome`,
        'lint',
        '--vcs-use-ignore-file=false',
        '--only=complexity/noExcessiveLinesPerFunction',
        '--only=style/useNamingConvention',
        '--reporter=json',
        '{files}',
      ],
    },
    staticCheck('scripts/check-test-fixtures.ts'),
    staticCheck('scripts/check-test-placement.ts'),
    staticCheck('scripts/check-test-reach.ts', [qualityMode]),
    staticCheck('scripts/check-test-spawns.ts'),
    staticCheck('scripts/check-dead-code.ts', [qualityMode], 'unused-exports', true),
    staticCheck('scripts/check-brand.ts'),
    staticCheck('scripts/check-legacy-names.ts'),
    staticCheck('scripts/check-doc-editor-rich-style.ts'),
    staticCheck('scripts/check-harness-mirror.ts'),
    staticCheck('scripts/check-canon-drift.ts'),
    staticCheck('scripts/check-ci-workflow.ts'),
    staticCheck('scripts/generate-recipe-schema.ts', ['--check']),
    staticCheck('orchestrator/scripts/check-pack-budget.ts'),
    staticCheck('orchestrator/scripts/check-canon-lint.ts'),
    staticCheck('scripts/quality/check-test-substance.ts', [qualityMode], 'test-substance'),
  ]
  const omittedChecks = new Set(
    checkArguments.omit.flatMap((group) => STATIC_OMIT_GROUPS[group].checks),
  )
  for (const group of checkArguments.omit) {
    const plan = STATIC_OMIT_GROUPS[group]
    console.log(`omitting ${group} static checks (${plan.checks.join(', ')}): ${plan.reason}`)
  }
  for (const check of staticChecks) {
    if (!omittedChecks.has(check.name)) gateSteps.push(await recordGateStep(check))
  }
}

if (reportDirectory) rmSync(reportDirectory, { recursive: true, force: true })

clearTimeout(runtimeDeadline)
const summary = printSummary()
if (!summary) throw new Error('check summary printed before budget checks')
const { elapsedMs, cpuMs } = summary
const cpuBudgetVerdict = decideRuntimeBudget({
  elapsedMs: cpuMs,
  budgetMs: cpuBudgetMs(checkArguments.mode),
  ci: checkArguments.mode === 'suite' && Boolean(process.env.CI),
  measure: 'cpu',
})
if (checkArguments.mode === 'suite') {
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
  if (cpuBudgetVerdict === 'over-informational') {
    console.log('suite CPU budget is informational locally')
  }
  if (cpuBudgetVerdict === 'over-fatal') {
    console.error(
      `suite CPU budget exceeded by ${((cpuMs - SUITE_CPU_BUDGET_MS) / 1000).toFixed(2)}s`,
    )
  }
}
if (checkArguments.mode === 'static' && cpuBudgetVerdict === 'over-informational') {
  console.log('static CPU budget is informational because static work runs on varying hosts')
}
const gate = decideGateOutcome(gateSteps)
if (gate.failures.length > 0) {
  console.error('gate failures:')
  for (const name of gate.failures) console.error(name)
}
if (cpuBudgetVerdict === 'over-fatal' || gate.exitCode !== 0) process.exit(1)
