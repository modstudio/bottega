import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openReadOnlyDatabase } from '../orchestrator/src/database/db.ts'
import { projectAt } from '../orchestrator/src/project/projects.ts'
import { biomeFindings } from '../orchestrator/src/ratchet/biome-adapter.ts'
import { classifyCaller } from '../shared/caller-classification'
import { changeViewPlan } from '../shared/change-view.ts'
import {
  CHECK_EXECUTION_FILE_ENV,
  type CheckExecutionRecord,
  UNIT_TEST_CHECK_CATEGORY,
} from '../shared/check-execution'
import { borrowedCheckoutOf, inspectionGitEnv, mainCheckoutOf } from '../shared/git'
import { findingLine } from '../shared/ratchet.ts'
import {
  decideGateOutcome,
  FAILED_STEP_DETAIL_LINES,
  type GateStepResult,
} from './check-outcome.ts'
import { CHECK_LEGS, ROOT_TEST_FILES, STATIC_OMIT_GROUPS } from './check-plan.ts'
import {
  attributeCommandCpu,
  type CheckArguments,
  type CommandCpuSample,
  cpuBudgetMs,
  decideRuntimeBudget,
  dependencyInstallDecision,
  dependencyProvisioningBase,
  HUNG_SUITE_TIMEOUT_MS,
  parseCheckArguments,
  runsRootSuiteTests,
  SUITE_CPU_BUDGET_MS,
  SUITE_RUNTIME_BUDGET_MS,
  selectedCheckLegs,
} from './check-runtime'
import { resolveLandingBase } from './landing-base'
import { readRemainingReport } from './remaining-report.ts'
import {
  BIOME_CHECK_NAME,
  staticCheckPlan,
  workerBiomeFiles,
  workerCheckProjection,
} from './static-check-plan.ts'

type Command = { cwd: string; argv: string[]; category?: string }
type Leg = {
  name: (typeof CHECK_LEGS)[number]['name']
  typecheck: Command | null
  worker: (typeof CHECK_LEGS)[number]['worker']
  suite: Command[]
}
type RunnableLeg = { name: string; commands: Command[] }
type LegResult = GateStepResult & { tail: string[] }
type StaticCheck = { name: string; argv: string[]; category?: string; reportPath?: string }
type ExecutionObservation = Pick<StaticCheck, 'category' | 'reportPath'> & { check?: string }

const root = fileURLToPath(new URL('..', import.meta.url))
const STATIC_CHECKS = staticCheckPlan()
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
const STEP_OUTPUT_DRAIN_TIMEOUT_MS = 2_000
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
  typecheck: leg.typecheck ? { cwd: `${root}${leg.directory}`, argv: [...leg.typecheck] } : null,
  worker: leg.worker,
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
  const detail: string[] = []
  let omittedDetailLines = 0
  const streamReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>()
  const child = track(
    Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe' }),
    describeCommand(argv, cwd),
    observation,
    startedAt,
  )
  const readers = [
    pump(child.stdout, '', detail, {
      error: false,
      raw: true,
      tailLines: FAILED_STEP_DETAIL_LINES,
      readers: streamReaders,
      onDrop: () => {
        omittedDetailLines += 1
      },
    }),
    pump(child.stderr, '', detail, {
      error: true,
      raw: true,
      tailLines: FAILED_STEP_DETAIL_LINES,
      readers: streamReaders,
      onDrop: () => {
        omittedDetailLines += 1
      },
    }),
  ]
  const exitCode = await child.exited
  let drainTimer: ReturnType<typeof setTimeout>
  const drained = await Promise.race([
    Promise.all(readers).then(() => true),
    new Promise<false>((resolve) => {
      drainTimer = setTimeout(() => resolve(false), STEP_OUTPUT_DRAIN_TIMEOUT_MS)
    }),
  ])
  clearTimeout(drainTimer!)
  if (!drained) {
    for (const reader of streamReaders) void reader.cancel().catch(() => {})
  }
  return {
    exitCode,
    detail,
    omittedDetailLines,
    ...(drained
      ? {}
      : { note: 'output stayed open after the step exited; a descendant process still holds it' }),
  }
}

function materializeStaticCheck(
  declaration: (typeof STATIC_CHECKS)[number],
  qualityBase: string,
): StaticCheck {
  const reportPath =
    declaration.reportsRemaining && reportDirectory
      ? join(reportDirectory, `${crypto.randomUUID()}.json`)
      : undefined
  return {
    name: declaration.name,
    argv: [
      ...declaration.argv({ root, qualityBase }),
      ...(reportPath ? [`--report=${reportPath}`] : []),
    ],
    category: declaration.category,
    reportPath,
  }
}

async function recordGateStep(check: StaticCheck): Promise<GateStepResult> {
  const result = await inherit(check.argv, root, {
    check: check.name,
    category: check.category,
    reportPath: check.reportPath,
  })
  return {
    name: check.name,
    ...(result.exitCode !== 0 && check.name === BIOME_CHECK_NAME
      ? await biomeErrorDetails(check.argv, result)
      : result),
  }
}

function qualityBase() {
  const base = resolveLandingBase(root, 'quality ratchet')
  collectCpu(describeCommand(base.command), base.cpuTime)
  return { argument: `--base=${base.commit}`, commit: base.commit }
}

async function pump(
  stream: ReadableStream<Uint8Array>,
  name: string,
  tail: string[],
  options: {
    error: boolean
    raw?: boolean
    tailLines?: number
    readers?: Set<ReadableStreamDefaultReader<Uint8Array>>
    onDrop?: () => void
  },
) {
  const { error, raw = false, tailLines = 40, readers, onDrop } = options
  const reader = stream.getReader()
  readers?.add(reader)
  const decoder = new TextDecoder()
  let pending = ''
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    if (raw) writeRawChunk(chunk.value, error)
    pending += decoder.decode(chunk.value, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop()!
    for (const line of lines) {
      observeGateWait(name, line)
      recordPumpedLine(name, line, tail, error, raw, tailLines, onDrop)
    }
  }
  pending += decoder.decode()
  if (pending) recordPumpedLine(name, pending, tail, error, raw, tailLines, onDrop)
  readers?.delete(reader)
}

function writeRawChunk(chunk: Uint8Array, error: boolean) {
  if (error) process.stderr.write(chunk)
  else process.stdout.write(chunk)
}

function observeGateWait(name: string, line: string) {
  const gateWait = name === 'orchestrator' && line.match(/^held (\d+)ms for host load /)
  if (!gateWait) return
  excludedGateWaitMs += Number(gateWait[1])
  armRuntimeDeadline()
}

function recordPumpedLine(
  name: string,
  line: string,
  tail: string[],
  error: boolean,
  raw: boolean,
  tailLines: number,
  onDrop?: () => void,
) {
  const prefixed = name ? `[${name}] ${line}` : line
  if (!raw) {
    if (error) console.error(prefixed)
    else console.log(prefixed)
  }
  tail.push(prefixed)
  if (tail.length > tailLines) {
    tail.shift()
    onDrop?.()
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
      pump(child.stdout, leg.name, tail, { error: false }),
      pump(child.stderr, leg.name, tail, { error: true }),
    ]
    const exitCode = await child.exited
    await Promise.all(readers)
    if (exitCode !== 0) return { name: leg.name, exitCode, detail: [], omittedDetailLines: 0, tail }
  }
  return { name: leg.name, exitCode: 0, detail: [], omittedDetailLines: 0, tail }
}

async function biomeErrorDetails(
  failedArgv: readonly string[],
  fallback: Pick<GateStepResult, 'exitCode' | 'detail' | 'omittedDetailLines' | 'note'>,
): Promise<Pick<GateStepResult, 'exitCode' | 'detail' | 'omittedDetailLines' | 'note'>> {
  try {
    const ciIndex = failedArgv.indexOf('ci')
    if (ciIndex === -1) throw new Error('Biome command has no ci subcommand')
    const argv = [
      ...failedArgv.slice(0, ciIndex + 1),
      '--reporter=json',
      '--diagnostic-level=error',
      '--max-diagnostics=none',
      ...failedArgv.slice(ciIndex + 1),
    ]
    const startedAt = performance.now()
    const child = track(
      Bun.spawn(argv, { cwd: root, stdout: 'pipe', stderr: 'ignore' }),
      describeCommand(argv),
      {},
      startedAt,
    )
    const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
    if (exitCode !== 0 && exitCode !== 1) {
      throw new Error(`Biome JSON pass exited ${exitCode}`)
    }
    const details = biomeFindings(Bun.stripANSI(output)).map(findingLine)
    if (details.length === 0) throw new Error('Biome JSON pass returned no diagnostics')
    return { exitCode: fallback.exitCode, detail: details, omittedDetailLines: 0 }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const reasonNote = `Biome error list could not be read: ${reason}`
    return { ...fallback, note: [fallback.note, reasonNote].filter(Boolean).join('; ') }
  }
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

function gitOutput(cwd: string, argv: string[]): Buffer | null
function gitOutput(cwd: string, argv: string[], failure: 'throw'): string
function gitOutput(cwd: string, argv: string[], failure: 'null' | 'throw' = 'null') {
  const result = Bun.spawnSync(['git', '--no-optional-locks', ...argv], {
    cwd,
    env: inspectionGitEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  collectCpu(describeCommand(['git', '--no-optional-locks', ...argv]), result.resourceUsage.cpuTime)
  if (result.exitCode !== 0) {
    if (failure === 'null') return null
    const detail = result.stderr.toString().trim()
    throw new Error(`git ${argv.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  if (failure === 'throw') return result.stdout.toString()
  return result.stdout.length ? result.stdout : null
}

function registeredLandingBranch(mainCheckout: string): string | null {
  let database: ReturnType<typeof openReadOnlyDatabase> | null = null
  try {
    database = openReadOnlyDatabase()
    return projectAt(mainCheckout, database)?.settings.trunk?.trim() || null
  } catch {
    return null
  } finally {
    database?.close()
  }
}

function provisionedLockfile(): Buffer | null {
  const mainCheckout = mainCheckoutOf(root)
  if (!mainCheckout) return null
  const borrowedCheckout = borrowedCheckoutOf(root) !== null
  const baseChoice = borrowedCheckout
    ? dependencyProvisioningBase({ borrowedCheckout: true })
    : (() => {
        const landingBranch = registeredLandingBranch(mainCheckout)
        return dependencyProvisioningBase({
          borrowedCheckout: false,
          landingBranch,
          remoteLandingRefResolved:
            landingBranch !== null &&
            gitOutput(root, ['rev-parse', '--verify', `origin/${landingBranch}`]) !== null,
        })
      })()
  if (baseChoice.kind === 'unresolved') return null
  if (baseChoice.kind === 'head') return gitOutput(root, ['show', 'HEAD:bun.lock'])
  const base = gitOutput(root, ['merge-base', 'HEAD', baseChoice.landingRef])?.toString().trim()
  if (!base) return null
  // The tracked writer recipe runs bun install after creating the tree at this base. Reading the
  // base commit keeps that provisioning source stable when the main checkout advances later.
  return gitOutput(root, ['show', `${base}:bun.lock`])
}

async function installDependencies() {
  const workerRun = classifyCaller(process.env).kind === 'worker'
  const sourceLockfile = workerRun ? provisionedLockfile() : null
  let lockfile: Buffer | null = null
  if (workerRun) {
    try {
      lockfile = readFileSync(lockfilePath)
    } catch {
      lockfile = null
    }
  }
  const decision = dependencyInstallDecision({
    workerRun,
    nodeModulesPresent: existsSync(nodeModulesPath),
    lockfileReadable: lockfile !== null,
    provisioningSourceResolved: sourceLockfile !== null,
    lockfileMatchesProvisioningSource:
      sourceLockfile !== null && (lockfile?.equals(sourceLockfile) ?? false),
  })
  if (decision === 'normal-install') return (await inherit(['bun', 'install', '--silent'])).exitCode
  if (decision === 'skip-provisioned') {
    console.log("INSTALL: skipped; worker dependencies match the tree's provisioning base")
    return 0
  }
  if (decision === 'refuse-missing-node-modules') {
    console.error(
      "INSTALL: refused; the worker's node_modules is missing; run the architect's gate to provision dependencies because a sandboxed worker has neither the Bun cache nor the network",
    )
    return 1
  }
  if (decision === 'refuse-unreadable-lockfile') {
    console.error(
      `INSTALL: refused; ${lockfilePath} is missing or unreadable; run the architect's gate to restore and provision dependencies`,
    )
    return 1
  }
  if (decision === 'refuse-unresolved-provisioning-source') {
    console.error(
      "INSTALL: refused; the worker's dependency provisioning source or its bun.lock could not be resolved; run the architect's gate to reprovision dependencies",
    )
    return 1
  }
  console.error(
    "INSTALL: refused; the worker's bun.lock differs from its provisioning base; a lockfile change needs the architect's gate because a sandboxed worker has neither the Bun cache nor the network",
  )
  return 1
}

if ((await installDependencies()) !== 0) process.exit(1)

const dependencyAuditExitCode = (
  await inherit(['bun', 'scripts/check-dependency-audit.ts'], root, {
    check: 'dependency audit',
  })
).exitCode
if (dependencyAuditExitCode !== 0) process.exit(1)

const rootTests = [
  // Every .githooks test must be named here. The list is explicit rather than a
  // glob so this runs in a fixed order, and the cost of that is
  // that an unnamed hook test is not gated at all - which reports safety it is
  // not providing.
  'bun',
  'test',
  ...ROOT_TEST_FILES.map((file) => `./${file}`),
]

const selected = new Set(selectedCheckLegs(checkArguments))
const workerProjection =
  checkArguments.mode === 'worker' ? workerCheckProjection(STATIC_CHECKS, legs) : null
let workerQualityBase: string | undefined
let workerBaseCommit: string | undefined
if (workerProjection) {
  try {
    const base = qualityBase()
    workerQualityBase = base.argument
    workerBaseCommit = base.commit
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
let workerBiomeStep: GateStepResult | null = null
if (workerProjection) {
  let files: string[]
  try {
    const plan = changeViewPlan(workerBaseCommit!, 'worktree')
    files = workerBiomeFiles({
      nameStatus: gitOutput(root, plan.nameStatus, 'throw'),
      untracked: gitOutput(root, plan.untracked!, 'throw'),
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  if (files.length === 0) {
    console.log(`Biome: skipped because no file changed since the base ${workerBaseCommit}`)
    workerBiomeStep = {
      name: workerProjection.biome.name,
      exitCode: 0,
      detail: [],
      omittedDetailLines: 0,
    }
  } else {
    const workerBiomeArgv = workerProjection.biome.workerArgv!({
      root,
      files,
    })
    const workerBiomeResult = await inherit(workerBiomeArgv, root)
    workerBiomeStep = {
      name: workerProjection.biome.name,
      ...(workerBiomeResult.exitCode !== 0
        ? await biomeErrorDetails(workerBiomeArgv, workerBiomeResult)
        : workerBiomeResult),
    }
  }
}
const results = await Promise.all(
  (workerProjection
    ? workerProjection.typecheckLegs
    : legs.filter((leg) => selected.has(leg.name))
  ).map((leg) =>
    runLeg({
      name: leg.name,
      commands:
        checkArguments.mode === 'static' || checkArguments.mode === 'worker'
          ? leg.typecheck
            ? [leg.typecheck]
            : []
          : leg.suite,
    }),
  ),
)
printFailedLegTails(results)
const gateSteps: GateStepResult[] = [...(workerBiomeStep ? [workerBiomeStep] : []), ...results]
if (checkArguments.mode === 'suite' && runsRootSuiteTests(checkArguments)) {
  const rootTestResult = await inherit(rootTests, root, { category: UNIT_TEST_CHECK_CATEGORY })
  gateSteps.push({
    name: 'root tests',
    ...rootTestResult,
  })
}

if (checkArguments.mode === 'static' || checkArguments.mode === 'worker') {
  let qualityMode: string
  try {
    qualityMode = workerQualityBase ?? qualityBase().argument
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  const staticChecks = STATIC_CHECKS.map((check) => materializeStaticCheck(check, qualityMode))
  const omittedChecks = new Set(
    checkArguments.omit.flatMap((group) => STATIC_OMIT_GROUPS[group].checks),
  )
  for (const group of checkArguments.omit) {
    const plan = STATIC_OMIT_GROUPS[group]
    console.log(`omitting ${group} static checks (${plan.checks.join(', ')}): ${plan.reason}`)
  }
  const selectedStaticChecks = workerProjection
    ? workerProjection.staticChecks.map((check) => materializeStaticCheck(check, qualityMode))
    : staticChecks.filter((check) => !omittedChecks.has(check.name))
  for (const check of selectedStaticChecks) {
    gateSteps.push(await recordGateStep(check))
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
  for (const line of gate.summary) console.error(line)
}
if (workerProjection) {
  console.log(
    `worker check omitted ${workerProjection.omitted.length} steps; bun run check runs them all`,
  )
  for (const check of workerProjection.omitted) {
    console.log(`not run by worker check: ${check.name} (${check.reason})`)
  }
}
if (cpuBudgetVerdict === 'over-fatal' || gate.exitCode !== 0) process.exit(1)
