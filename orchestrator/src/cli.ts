import { db, writableDb, sessionId, recordSessionSeen, writeTransaction } from './db.ts'; import { registerStandardHooks } from './store-hooks.ts'; registerStandardHooks()
import { pendingForSession } from './evidence-query.ts'
import { REVIEW_REPRODUCED, REVIEW_COVERAGE, REVIEW_LIMITS, REVIEW_OVERLAP, REVIEW_SEVERITY } from './review-vocabulary.ts'
import { reapStale } from './run-liveness.ts'; import { pidAlive } from './process-liveness.ts'
import { duelMatrices, unrecordedPairsForSession } from './duel.ts'
import { authorizeRunMutation, runMutationActor, auditRunMutation } from './run-authority.ts'
import { detach as dispatchDetached } from './run-dispatch.ts'
import {
  continueRun as continueControlledRun, follow as followRun,
  reportContinuedRun as reportControlledRun,
} from './run-control.ts'
import { answerRun, retryRun } from './run-answer.ts'
import { cleanupRepoRoot, discardRun, discardWorktree, type CleanupRow } from './cleanup.ts'
import { sweepRuns } from './cleanup-sweep.ts'
import { abandonRun, stopRun } from './run-stop.ts'
import { judgeRun, scoreRun } from './judgement.ts'
import { recalibrate } from './recalibration.ts'
import { clearConfinement } from './confinement-ruling.ts'
import { docCommand } from './doc-commands.ts'
import { projectCommand } from './project-commands.ts'
import { doctorCommand } from './doctor.ts'
import { portCommand } from './port-commands.ts'
import { reviewCommand } from './review-commands.ts'
import { runListingCommand } from './run-listing.ts'
import { runInboxCommand } from './run-inbox.ts'
import { runDiffCommand } from './run-diff.ts'
import { readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync, statSync, lstatSync, unlinkSync, openSync, fstatSync, closeSync, constants } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { projectAt, projectByName, projects } from './projects.ts'
import { classify, NOT_EVIDENCE } from './failure.ts'
import { collectResult, collectWait, resolveFailover } from './collect.ts'
import {
  CONTINUE_WORKING_FORMS, TELL_WORKING_FORMS,
  flagValue, flagValues, invalidUtf8Offset, nulByteOffset,
  parseWorkerMessageArgs, refuseMisparsedMessage, validateCliArgs,
} from './args.ts'
import {
  DASHBOARD_CAPABILITY_PATH_ENV, DASHBOARD_CAPABILITY_TOKEN_ENV,
  type DashboardCapability,
} from '../../shared/dashboard-capability.ts'
import {
  MONITOR_CAPABILITY_PATH_ENV, MONITOR_CAPABILITY_TOKEN_ENV,
  type MonitorCapability,
} from '../../shared/monitor-capability.ts'

type DetachSpec = import('./failover.ts').DetachSpec
type McpRequest = import('./mcp-preflight.ts').McpRequest
type RoutingBacktest = import('./routing-backtest.ts').RoutingBacktest

let jobsModule: typeof import('./jobs.ts')
let agentsModule: typeof import('./agents.ts')
let routeModule: typeof import('./route.ts')
let guideModule: typeof import('./guide.ts')
let runArtifactsModule: typeof import('./run-artifacts.ts'); let closeOutModule: typeof import('./close-out.ts')
let dispatchPreflightModule: typeof import('./dispatch-preflight.ts'); let reviewTargetModule: typeof import('./review-target.ts')
let preflight!: typeof import('./dispatch-preflight.ts').preflight; let implicitReviewWarning!: typeof import('./review-target.ts').implicitReviewWarning
let worktreeModule!: typeof import('./worktree.ts')
let contractModule!: typeof import('./contract.ts')
let grokTrustModule!: typeof import('./grok-trust.ts')
let workflowsModule!: typeof import('./workflows.ts')
let agreementModule!: typeof import('./agreement.ts')
let routingBacktestModule!: typeof import('./routing-backtest.ts')

let JOBS!: typeof import('./jobs.ts').JOBS
let job!: typeof import('./jobs.ts').job
let isReaderJob!: typeof import('./jobs.ts').isReaderJob
let reclaimsTreeByDefault!: typeof import('./jobs.ts').reclaimsTreeByDefault
let resolveJobTimeoutMs!: typeof import('./jobs.ts').resolveJobTimeoutMs
let jobBoundInstructionForContract!: typeof import('./jobs.ts').jobBoundInstructionForContract
let jobTimeoutHelp!: typeof import('./jobs.ts').jobTimeoutHelp
async function loadJobs() {
  jobsModule ??= await import('./jobs.ts')
  ;({ JOBS, job, isReaderJob, reclaimsTreeByDefault, resolveJobTimeoutMs,
      jobBoundInstructionForContract, jobTimeoutHelp } = jobsModule)
}
let AGENTS!: typeof import('./agents.ts').AGENTS
let available!: typeof import('./agents.ts').available
let installed!: typeof import('./agents.ts').installed
let ensureLocalHealth!: typeof import('./agents.ts').ensureLocalHealth
let unavailableReason!: typeof import('./agents.ts').unavailableReason
let readStrictCodexSchema!: typeof import('./agents.ts').readStrictCodexSchema
let resumePromptByteLimit!: typeof import('./agents.ts').resumePromptByteLimit
let agentRows!: typeof import('./agents.ts').agentRows
let addAgent!: typeof import('./agents.ts').addAgent
let setAgent!: typeof import('./agents.ts').setAgent
let removeAgent!: typeof import('./agents.ts').removeAgent
let probeAgent!: typeof import('./agents.ts').probeAgent
async function loadAgents() {
  agentsModule ??= await import('./agents.ts')
  ;({ AGENTS, available, installed, ensureLocalHealth, unavailableReason,
      readStrictCodexSchema, resumePromptByteLimit,
      agentRows, addAgent, setAgent, removeAgent, probeAgent } = agentsModule)
}
let candidates!: typeof import('./route.ts').candidates
let pick!: typeof import('./route.ts').pick
let scoreboard!: typeof import('./route.ts').scoreboard
let MIN_SAMPLE!: typeof import('./route.ts').MIN_SAMPLE
let promptSizeBucketLabel!: typeof import('./route.ts').promptSizeBucketLabel
async function loadRoute() { routeModule ??= await import('./route.ts'); ({ candidates, pick, scoreboard, MIN_SAMPLE, promptSizeBucketLabel } = routeModule) }
let guide!: typeof import('./guide.ts').guide
async function loadGuide() { guideModule ??= await import('./guide.ts'); ({ guide } = guideModule) }
let RUNS_DIR!: typeof import('./run-artifacts.ts').RUNS_DIR
let terminateRunProcesses!: typeof import('./run-process.ts').terminateRunProcesses
let closeOutRun!: typeof import('./close-out.ts').closeOutRun
async function loadRun() { runArtifactsModule ??= await import('./run-artifacts.ts'); closeOutModule ??= await import('./close-out.ts')
  dispatchPreflightModule ??= await import('./dispatch-preflight.ts'); reviewTargetModule ??= await import('./review-target.ts'); ({ preflight } = dispatchPreflightModule); ({ implicitReviewWarning } = reviewTargetModule)
  ;({ RUNS_DIR } = runArtifactsModule); ({ closeOutRun } = closeOutModule)
  ;({ terminateRunProcesses } = await import('./run-process.ts'))
}
let transportModule: typeof import('./transport.ts')
let assertAcpAllowed!: typeof import('./transport.ts').assertAcpAllowed
let assertAcpReady!: typeof import('./transport.ts').assertAcpReady
let resolveTransportName!: typeof import('./transport.ts').resolveTransportName
let selectAgentForTransport!: typeof import('./transport.ts').selectAgentForTransport
async function loadTransport() {
  transportModule ??= await import('./transport.ts')
  ;({ assertAcpAllowed, assertAcpReady, resolveTransportName, selectAgentForTransport } = transportModule)
}
let resolveBase!: typeof import('./worktree.ts').resolveBase
let checkoutHasUncommittedWork!: typeof import('./worktree.ts').checkoutHasUncommittedWork; let callerDrift!: typeof import('./worktree.ts').callerDrift
async function loadWorktree() { worktreeModule ??= await import('./worktree.ts'); ({ resolveBase, checkoutHasUncommittedWork, callerDrift } = worktreeModule) }
let WORKER_PREAMBLE!: typeof import('./contract.ts').WORKER_PREAMBLE
let READONLY_PREAMBLE!: typeof import('./contract.ts').READONLY_PREAMBLE
let NO_REPO_PREAMBLE!: typeof import('./contract.ts').NO_REPO_PREAMBLE
let REVIEW_SEVERITY_INSTRUCTION!: typeof import('./contract.ts').REVIEW_SEVERITY_INSTRUCTION
let contractConflicts!: typeof import('./contract.ts').contractConflicts
async function loadContract() { contractModule ??= await import('./contract.ts'); ({ WORKER_PREAMBLE, READONLY_PREAMBLE, NO_REPO_PREAMBLE, REVIEW_SEVERITY_INSTRUCTION, contractConflicts } = contractModule) }
let grokTrustHeadings!: typeof import('./grok-trust.ts').grokTrustHeadings
let grokTrustPathFromHeading!: typeof import('./grok-trust.ts').grokTrustPathFromHeading
async function loadGrokTrust() { grokTrustModule ??= await import('./grok-trust.ts'); ({ grokTrustHeadings, grokTrustPathFromHeading } = grokTrustModule) }
let composeWorkflow!: typeof import('./workflows.ts').composeWorkflow
let exportWorkflows!: typeof import('./workflows.ts').exportWorkflows
let forkWorkflow!: typeof import('./workflows.ts').forkWorkflow
let getWorkflowStep!: typeof import('./workflows.ts').getWorkflowStep
let importWorkflows!: typeof import('./workflows.ts').importWorkflows
let listWorkflows!: typeof import('./workflows.ts').listWorkflows
let promoteWorkflow!: typeof import('./workflows.ts').promoteWorkflow
let retireWorkflow!: typeof import('./workflows.ts').retireWorkflow
let setWorkflow!: typeof import('./workflows.ts').setWorkflow
let showWorkflow!: typeof import('./workflows.ts').showWorkflow
let workflowVersions!: typeof import('./workflows.ts').workflowVersions
async function loadWorkflows() { workflowsModule ??= await import('./workflows.ts'); ({ composeWorkflow, exportWorkflows, forkWorkflow, getWorkflowStep, importWorkflows, listWorkflows, promoteWorkflow, retireWorkflow, setWorkflow, showWorkflow, workflowVersions } = workflowsModule) }
let bradleyTerry!: typeof import('./agreement.ts').bradleyTerry
async function loadAgreement() { agreementModule ??= await import('./agreement.ts'); ({ bradleyTerry } = agreementModule) }
let routingBacktest!: typeof import('./routing-backtest.ts').routingBacktest
let routingBacktestEnsemble!: typeof import('./routing-backtest.ts').routingBacktestEnsemble
async function loadRoutingBacktest() { routingBacktestModule ??= await import('./routing-backtest.ts'); ({ routingBacktest, routingBacktestEnsemble } = routingBacktestModule) }

/**
 * How long `orch do` watches a detached run before handing it back.
 *
 * Derived, not guessed: every agent's own timeout is held below STALE_AFTER_MS
 * (asserted in the suite), and the reaper sweeps anything older, so a run has
 * always reached a terminal state by then. The extra minute is for the reaper's
 * own poll to land.
 */

/** Test-only ordering seam for database interleavings at lifecycle boundaries. */
function lifecycleCheckpoint(name: string): void {
  if (process.env.ORCH_TEST_LIFECYCLE_CHECKPOINT !== name) return
  const ready = process.env.ORCH_TEST_LIFECYCLE_READY
  const release = process.env.ORCH_TEST_LIFECYCLE_RELEASE
  if (!ready || !release) return
  writeFileSync(ready, `${name}\n`)
  while (!existsSync(release)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
}

/**
 * How to score THIS run — the right id and the right axes.
 *
 * Both halves were wrong and both misled a session today. A child turn's line
 * named the child, which `orch score` then refuses because a conversation is
 * one unit of work and the root carries the verdict; being told to run a
 * command that is rejected is worse than being told nothing. And every hint
 * printed the two-axis form, including for writing jobs that require fidelity —
 * so the person following the prompt on screen got an error, while the correct
 * form was only in a document.
 */
function scoreHint(id: number, jobName: string, parent: number | null): string {
  const target = parent ?? id
  return `orch score ${target} <none|partial|full> [wrong|mixed|right]`
    + scoreSuffix(jobName)
    + ' --note "..."'
    + (parent ? `   # the whole conversation, not turn ${id}` : '')
}

function scoreSuffix(jobName: string): string {
  const writes = Boolean(JOBS[jobName]?.needs.writesRepo)
  const reviewGrades = JOBS[jobName]?.findings
    ? ` [--reproduced ${REVIEW_REPRODUCED.join('|')}] [--coverage ${REVIEW_COVERAGE.join('|')}]` +
      ` [--limits ${REVIEW_LIMITS.join('|')}] [--overlap ${REVIEW_OVERLAP.join('|')}]`
    : ''
  return (writes ? ' [drifted|partial|faithful]' : '') + reviewGrades
}

function pairHint(partner: { id: number; agent: string }): string {
  const reason = 'reason' in partner ? String(partner.reason) : 'same task'
  return `pair: run ${partner.id} (${partner.agent}) is comparable (${reason}) — record with ` +
    `--better-than ${partner.id} | --worse-than ${partner.id} | --same-as ${partner.id}`
}

/**
 * A run whose output is not evidence about the agent must say so on the
 * record a person reads — otherwise they score another run's work, which
 * is how colliding output files taught the router a lie. The reason is
 * the column's own text; NULL means nothing to say.
 */
const THIN_OUTPUT_BYTES = 1024
const THIN_OUTPUT_LATENCY_MS = 5 * 60_000

/** A reader-facing suspicion only: this never enters status, scoring, or routing. */
function thinOutputWarning(row: {
  job: string; status: string; latency_ms: number | null; probe: number
  output_path: string | null
}): string | null {
  if (row.status !== 'ok' || row.probe || row.latency_ms === null ||
      row.latency_ms <= THIN_OUTPUT_LATENCY_MS || job(row.job).needs.writesRepo ||
      !row.output_path || !existsSync(row.output_path)) return null
  // Test-only race seam: production never sets this. It deterministically
  // exercises expiry between the existence check above and the stat below.
  if (process.env.ORCH_TEST_THIN_OUTPUT_UNLINK_BEFORE_STAT === row.output_path) {
    unlinkSync(row.output_path)
  }
  let bytes: number
  try {
    bytes = statSync(row.output_path).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (bytes >= THIN_OUTPUT_BYTES) return null
  return `thin: ${bytes} B after ${dur(row.latency_ms).replaceAll(' ', '')} — ` +
    'check whether the run stopped at a blocker'
}

/** A run id is a machine interface: callers feed it back to wait/result. */
function printRunId(id: number): void {
  process.stdout.write(`${id}\n`)
}

/** A command must not finish while a machine-readable stdout write is still buffered. */
function writeStdout(output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(output, (error) => error ? reject(error) : resolve())
  })
}

/**
 * Warn once per session and drift state, even when a fan-out starts several
 * independent `orch do` processes. The marker is runtime state beside run
 * artifacts, not repository state, and `wx` makes the first process the only
 * one that prints.
 */
function warnCallerDrift(cwd: string, baseRef?: string): void {
  const drift = callerDrift(cwd, baseRef)
  if (!drift) return
  const key = createHash('sha256').update(JSON.stringify([
    sessionId() ?? 'no-session', realpathSync(cwd), drift.callerHead, drift.base,
  ])).digest('hex')
  const dir = join(RUNS_DIR, '.signals')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `caller-drift-${key}`), '', { flag: 'wx' })
  } catch {
    return
  }
  console.error(
    `! caller checkout HEAD ${drift.callerHead} is behind or diverged from ` +
    `${drift.baseRef} (${drift.base}).\n` +
    '  Update the caller checkout; repository runs from it are still dispatched.',
  )
}

/**
 * Printed AFTER the run is claimed, because the id does not exist before then
 * and a warning that cannot name the run reads as a refusal.
 *
 * The whole text has to say the run started. A pre-claim warning plus a later
 * line is two messages; a reader who only sees the first still stops.
 */
function warnImplementContractConflicts(
  conflicts: ReturnType<typeof contractConflicts>,
  runId: number,
): void {
  if (!conflicts.length) return
  console.error(
    '! implement spec may conflict with its no-push/no-merge/no-rewrite contract:',
  )
  for (const conflict of conflicts) {
    console.error(`  line ${conflict.line}: ${conflict.text}`)
  }
  console.error(
    `  The spec was not changed. Run ${runId} has started; review the spec before the worker reaches this conflict.`,
  )
}

async function follow(id: number, quiet: boolean, exitOnFailure = true): Promise<string> {
  return followRun(id, quiet, exitOnFailure, { dur, scoreHint, argvResumeLimit, printRunId })
}

const argv = process.argv.slice(2)
const cmd = argv[0]

// One invocation is one heartbeat. Keeping it at the process boundary avoids
// turning the many read helpers below into competing writers.
const readOnlyInvocation =
  (cmd === 'port' && argv[1] === 'import' && argv.includes('--dry-run')) ||
  (cmd === 'review' && ['coverage-audit', 'yield'].includes(argv[1] ?? ''))
if (!readOnlyInvocation && cmd !== 'init-db' && cmd !== 'migrate') recordSessionSeen()

/** Human-readable duration: seconds under a minute, then m/s, then h/m. */
function dur(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const t = ms / 1000
  if (t < 60) return `${t.toFixed(1)}s`
  const m = Math.floor(t / 60)
  if (m < 60) return `${m}m ${String(Math.round(t % 60)).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function flag(name: string): string | undefined {
  return flagValue(argv, name)
}
function flags(name: string): string[] {
  return flagValues(argv, name)
}
const has = (n: string) => argv.includes(`--${n}`)

function scoreNote(): string | null {
  const inline = flag('note')
  const file = flag('note-file')
  if (inline !== undefined && file !== undefined) {
    throw new Error('pass a score note with either --note or --note-file, not both')
  }
  const note = file === undefined ? inline : readFileSync(file, 'utf8')
  if (note === undefined) return null
  const unescaped = (quote: string) => {
    let count = 0
    for (let i = 0; i < note.length; i++) {
      if (note[i] !== quote) continue
      // Apostrophes inside words are prose, not shell quoting.
      if (quote === "'" && /[\p{L}\p{N}]/u.test(note[i - 1] ?? '') &&
          /[\p{L}\p{N}]/u.test(note[i + 1] ?? '')) continue
      let slashes = 0
      for (let j = i - 1; j >= 0 && note[j] === '\\'; j--) slashes++
      if (slashes % 2 === 0) count++
    }
    return count
  }
  if (note.trim() === '``' || ['"', "'", '`'].some((quote) => unescaped(quote) % 2 !== 0)) {
    throw new Error(
      'score note looks like an unexpanded shell fragment (a lone backtick pair or an unbalanced quote); ' +
      'put the note in a file and pass --note-file <path>',
    )
  }
  return note
}

function requestedMcp(): McpRequest | undefined {
  const values = argv.filter((arg) => arg === '--mcp' || arg.startsWith('--mcp='))
  if (values.length > 1) throw new Error('--mcp may be supplied only once')
  if (!values.length) return undefined
  return values[0] === '--mcp=prefer' ? 'prefer' : 'require'
}

/** Flags that consume the next argument. Anything else is a boolean switch. */
const VALUE_FLAGS = new Set(['--agent', '--file', '--schema', '--model', '--transport', '--note', '--note-file', '--message', '--unreviewed',
                             '--id', '--job', '--limit', '--port', '--days', '--window', '--timeout', '--scorer',
                             '--seed', '--key', '--repo', '--base', '--review', '--avoid', '--distinct-from', '--label', '--lens', '--deliverable', '--category', '--severity',
                             '--strand-live',
                             '--reproduced', '--coverage', '--limits', '--overlap', '--writer',
                             '--finding', '--better-than', '--worse-than', '--same-as', '--n',
                             '--scope', '--subject', '--title', '--cwd', '--question', '--excludes', '--slots', '--slots-file',
                             '--enabled', '--reason', '--axis', '--name', '--body', '--body-file', '--version'])


function keptBranchLine(
  branch: string, uniqueCount: number, afterCutCount: number | null, id: number,
): string {
  const reason = afterCutCount === null
    ? `${uniqueCount} commit(s) reachable only from this branch`
    : `deleting it would lose commits reachable from no other ref; ` +
      `${afterCutCount} commit(s) after the cut`
  return `kept branch ${branch}: ${reason} — ` +
    `merge it, or orch discard ${id} --force to delete it after checking no other run owns it`
}

const cleanupPresentation = { log: (...v: unknown[]) => console.log(...v), error: (...v: unknown[]) => console.error(...v), setExitCode: (code: number) => { process.exitCode = code }, keptBranchLine }
const judgementPresentation = { log: (...v: unknown[]) => console.log(...v), error: (...v: unknown[]) => console.error(...v), pairHint }
function auditReason(): string | null {
  const scorer = flag('scorer')
  if (scorer) return `--scorer ${scorer}`
  if (has('force')) return '--force'
  return flag('unreviewed') ?? flag('note') ?? null
}

function dashboardScoreAuthorized(scorer: string | undefined): boolean {
  if (scorer !== 'hub-dashboard') return false
  const path = process.env[DASHBOARD_CAPABILITY_PATH_ENV]
  const presented = process.env[DASHBOARD_CAPABILITY_TOKEN_ENV]
  if (!path || !presented || typeof process.getuid !== 'function') return false
  try {
    const uid = process.getuid()
    const file = lstatSync(path)
    const dir = lstatSync(dirname(path))
    if (!file.isFile() || file.isSymbolicLink() || !dir.isDirectory() || dir.isSymbolicLink()) return false
    if (file.uid !== uid || dir.uid !== uid || (file.mode & 0o777) !== 0o600 || (dir.mode & 0o777) !== 0o700) {
      return false
    }
    const capability = JSON.parse(readFileSync(path, 'utf8')) as DashboardCapability
    if (!Number.isInteger(capability.pid) || capability.pid < 1 || typeof capability.token !== 'string') return false
    const expected = Buffer.from(capability.token)
    const actual = Buffer.from(presented)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || !pidAlive(capability.pid)) {
      return false
    }
    const observed = Bun.spawnSync(['ps', '-p', String(capability.pid), '-o', 'command='], {
      stdout: 'pipe', stderr: 'pipe',
    })
    if (observed.exitCode !== 0) return false
    const words = new TextDecoder().decode(observed.stdout).trim().split(/\s+/)
    return words.some((word, index) =>
      (word === 'hub' || word.endsWith('/bin/hub') || word.endsWith('/hub/src/cli.ts')) &&
      words[index + 1] === 'serve')
  } catch {
    return false
  }
}

function monitorDeliveryAuthorized(): boolean {
  const path = process.env[MONITOR_CAPABILITY_PATH_ENV]
  const presented = process.env[MONITOR_CAPABILITY_TOKEN_ENV]
  if (!path || !presented || typeof process.getuid !== 'function') return false
  let capabilityFd: number | undefined
  try {
    const uid = process.getuid()
    const dir = lstatSync(dirname(path))
    if (!dir.isDirectory() || dir.isSymbolicLink()) return false
    if (dir.uid !== uid || (dir.mode & 0o777) !== 0o700) return false
    capabilityFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const file = fstatSync(capabilityFd)
    if (!file.isFile() || file.uid !== uid || (file.mode & 0o777) !== 0o600) return false
    const capability = JSON.parse(readFileSync(capabilityFd, 'utf8')) as MonitorCapability
    if (!Number.isInteger(capability.pid) || capability.pid < 1 || typeof capability.token !== 'string') return false
    const expected = Buffer.from(capability.token)
    const actual = Buffer.from(presented)
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual) ||
        capability.pid !== process.ppid || !pidAlive(capability.pid)) return false
    const observed = Bun.spawnSync(['/bin/ps', '-p', String(capability.pid), '-o', 'command='], {
      stdout: 'pipe', stderr: 'pipe',
    })
    if (observed.exitCode !== 0) return false
    const words = new TextDecoder().decode(observed.stdout).trim().split(/\s+/)
    let executable = words[0]
    const interpreter = executable ? basename(executable) : ''
    if (/^(?:python(?:3(?:\.\d+)?)?|ba?sh|zsh|dash)$/i.test(interpreter)) {
      executable = words[1]
    }
    if (!executable) return false
    const deliveryHooks = new Set([
      realpathSync(new URL('../hooks/orch-heartbeat.sh', import.meta.url).pathname),
      realpathSync(new URL('../hooks/session-brief.py', import.meta.url).pathname),
    ])
    try { return deliveryHooks.has(realpathSync(executable)) } catch { return false }
  } catch {
    return false
  } finally {
    if (capabilityFd !== undefined) closeSync(capabilityFd)
  }
}


async function detach(jobName: string, prompt: string, spec: DetachSpec): Promise<number> {
  let selectedAgent: string | undefined
  if (!spec.resume && spec.mcp) {
    await loadRoute()
    const { stackAt } = await import('./projects.ts')
    selectedAgent = pick(jobName, spec.agent, prompt.length, true, stackAt(spec.cwd ?? process.cwd()),
      { agents: spec.avoid, models: spec.distinctModels, model: spec.model }, spec.probe, spec.lens).agent
  }
  return dispatchDetached(jobName, prompt, spec, selectedAgent)
}

async function continueRun(id: number, message?: string): Promise<{ childId: number; job: string }> {
  return continueControlledRun(id, message, argvResumeLimit)
}

async function reportContinuedRun(childId: number, jobName: string): Promise<void> {
  return reportControlledRun(childId, jobName, {
    detach: has('detach'), follow: has('follow'), quiet: has('quiet'),
  }, { dur, scoreHint, argvResumeLimit, printRunId })
}
function chainHasPendingDelivery(rootId: number): boolean {
  return Boolean(db().query(
    `SELECT 1 FROM question q JOIN run owner ON owner.id=q.run_id
      WHERE (owner.id=? OR owner.parent_run_id=?)
        AND q.answered_at IS NOT NULL AND q.delivery_pending_at IS NOT NULL
      LIMIT 1`,
  ).get(rootId, rootId))
}

function chainIsStranded(rootId: number): boolean {
  return chainHasPendingDelivery(rootId)
}

function strandedRecovery(rootId: number): string {
  return `stranded — orch retry ${rootId} --agent … with the recorded ruling, or orch abandon ${rootId}`
}

function baseHelp(description: string): string {
  return description
}

function usage(): never {
  console.log(`orch — delegate work to external agents and score them per job type

  orch do <job> [prompt]        run a job; prompt from argv, --file, or stdin
      --detach                  print a run id and return at once (the default); collect with
                                'orch wait' and 'orch result'. This is how a
                                fan-out is done: N detaches, one wait.
      --porcelain               print exactly the run id, for machine callers
      --agent <name>            force an agent instead of routing
      --transport cli|acp       driver seam; default cli. acp covers codex/grok read-only jobs
      --avoid <agent>[,...]     route to any other agent when possible
      --distinct-from <id>[,...] avoid models used by earlier fan-out runs
      --base <ref>              ${baseHelp('base an implement or fix worktree on this git commit')}
      --review <branch|run-id>  review that branch tip explicitly (review-lens, safety, craft)
      --carry                   carry this checkout's uncommitted work into the worker (off by default)
      --file <path>             read the prompt from a file
      --schema <path>           bind JSON schema (Codex normalizes it to OpenAI strict mode)
      --mcp                     require a successful pre-launch MCP tool call
      --mcp=prefer              record MCP call evidence; continue if unavailable or unverified
      --model <name>            override the agent's model
      --label <text>            name this run in listings and pending reminders
      --lens <stable-id>        required identity for findings-producing review jobs
      --quiet                   print only the reply
      --probe                   a calibration run: recorded, but not routing evidence
      --seed <spec>             choose a required project-specific database seed spec (writing jobs only)
      --seed=<spec>             same; quote a multi-token spec as one value in either form
      --key <KEY-123>           attribute a read-only run, or supply a writing run's required branch key
      --repo <name>             attribute work launched outside a registered project
      --cwd <path>              resolve and carry from this path as if orch started there
      --follow                  block and watch the run instead of returning its id
      --no-failover             do not retry vendor failures on another agent
      --no-wait-capacity        take the next eligible agent when the preferred row is at its concurrency cap
      --deliverable <text>      declare a named reader deliverable (repeatable; diagnose, understand, file-question)
      --timeout <minutes>       override the job's default timeout, within that job's ceiling
      --keep-tree               keep a lens or reader worktree instead of reclaiming it at terminalisation

  orch issue <TASK-KEY>         reproduce, diagnose, fix and independently verify one filed issue

  orch contract <job>          print the preamble prepended to that job's prompt
  orch note "<text>" [--same-as ID|--new]
                                file a cwd-bound suggestion through hub

  orch score <run-id> <none|partial|full> [wrong|mixed|right] [--note "..."|--note-file PATH]
      delivery first (did an answer arrive), then quality (was it right).
      'none' takes no quality — there was nothing to judge.
      findings-producing lenses with an answer also require:
      --reproduced <${REVIEW_REPRODUCED.join('|')}> --coverage <${REVIEW_COVERAGE.join('|')}>
      --limits <${REVIEW_LIMITS.join('|')}> --overlap <${REVIEW_OVERLAP.join('|')}>
      only the session that MADE a run may score it; --force overrides.
      --better-than <id>[,<id>] record this run winning a pairwise comparison
      --worse-than <id>[,<id>]  record the named run winning the comparison
      --same-as <id>[,<id>]     mark a tie without recording a duel
      --scorer <who>            record the named human/UI scorer; only the local
                                hub-dashboard capability bypasses ownership
      --void                    retain the run and output, but exclude it from routing evidence
  orch judge <run-id> <none|partial|full> [wrong|mixed|right] [drifted|partial|faithful]
      closes scoring, findings triage/review completion, and any comparable pair in one call
      --finding N=<accepted|modified|skipped>:<severity>
      --finding N=rejected:<category>
      --discard                 reclaim the terminal run's worktree after close-out
  orch recalibrate [--n 12]    re-score old outputs blind and measure agreement
      --scorer <who>            use the same scorer identity as orch score
      --force                   sample any scorer's old scores
  orch routing-backtest [--job X] [--json]
                                replay current routing and Thompson sampling over judgements
  orch wait <run-id>...         block until those runs finish (--timeout SECONDS, default 1800)
  orch result <run-id>          print a finished run's output; exit 2 if still running
      --artifacts               list files kept under runs/<id>/artifacts/
  orch retry <run-id>           re-send a run's exact prompt [--agent NAME] [--model MODEL]
      --agent <name>            ... or to a different one, deliberately
  orch review tier <branch|run-id|from..to> classify review breadth without writing
  orch review yield [--project P] [--since ISO] [--task KEY|--key KEY] [--lens L] [--agent A] [--json]
                                findings and cost by lens, round ordinal, agent and model
  orch review record <run-id>... record completed lens outputs before triage
  orch review triage <review-id> <finding> <accepted|modified|rejected|skipped>
      --category <name>         required rejection category for rejected findings
      --severity <${REVIEW_SEVERITY.join('|')}> architect-assessed severity, including explicit agreement
  orch review complete <review-id> mark a fully triaged review complete
  orch review calibration <lens> <agent> <model> [--json]  (--json: one JSON document)
  orch review coverage-audit [--json]  list completed reviews that inspected trunk history (--json: one JSON document)
  orch pending                  runs YOU made that are still unscored (exit 1 if any)
  orch runs [--id ID]... [--job X] [--agent Y] [--limit N] [--unscored] [--since ISO] [--json|--json=v1]
      --json                    NDJSON, one envelope per line
      --json=v1                 transition format: NDJSON bare run objects
                         --id resolves a turn to its chain root and identifies the requested id
      --id queries exactly those run ids; repeat it for a union of ids
      --id and --since cannot be combined
      --json                    print one JSON object per line, with cwd, session id and questions: the interface hub reads
  orch stats [--job X]          success rate per agent per job
  orch guide [--job X] [--prompt-bytes N] [--lens LENS]
                                what to use for what, separated by prompt-size bucket
  orch spawns [--limit N]       what the subagent gate allowed and denied, and why
  orch pick <job>               show which agent would be chosen, and why
      --agent <name>            preview an explicit agent pin
      --avoid <agent>[,...]     preview routing away from these agents
      --distinct-from <id>[,...] preview routing away from models used by these runs
  orch state [--days N]         the dashboard payload as JSON (what hub renders)
      the dashboard itself is 'hub serve' - this concern routes and scores
  orch run <run-id> [--receipt] one exact turn's detail as JSON, with its chain root;
                                --receipt marks worker messages read
  orch search <query>           consult score notes, rulings, review findings, and saved outputs
      --limit <n>               compact results to return (default 20)
      --full                    include the complete matched records after choosing them
      --json                    print one JSON document, including unavailable output count
  orch metric [collect]         Claude tokens per shipped task (the ratio this exists to move)
  orch blockers [--days N] [--json]
      what stopped agents verifying their work, ordered by recurrence
      --json                    print one JSON document (the published surface; never orch.db)
  orch monitor [--backstop]     detect, record, report, and safely reconcile machine state
      --history [--limit N]     query recorded invocations; --json emits one JSON document
      --notices                 read this session's addressed conditions without consuming them
      --ack-notices IDS         mark emitted notice ids delivered (hook capability required)
      --json                    emit one JSON document; silent on a clean live pass
  orch reclaim worktree <path> [--dry-run]
      remove an orch worktree only after recipe/base, clean-state, reachability, and liveness proofs
  orch reclaim branch <project>:<branch> [--dry-run]
      remove a local branch only when every commit is reachable or its exact kept tip is recorded
  orch inbox [--all] [--json]   design questions a worker is waiting on you to rule on
      --json                    print one JSON document
  orch peek <run-id> [--events N] [--json]
                                observe a worker's event stream without interrupting it
  orch tell <id> ["<message>"]   queue non-authoritative context for a running worker
      --file <path>             read a long message from a file
      --ping                    also print the peek summary as of queue time
  orch setup-ask                register the live ask channel with codex and grok
  orch answer <id> ["<ruling>"] rule from argv, --file, or stdin; resume detached
      --file <path>             read the ruling from a file
      --q<id> --file <path>     read that question's ruling from a file
      --record-only             attach the ruling without resuming the worker
      --follow                  watch the resumed turn here instead
  orch continue <id> ["<what next>"]
      carry on a chain with no open question - one that was interrupted, or
      one you want to add to without paying for its context again
      --file <path>             read the follow-up from a file
      detaches by default; --follow watches the resumed turn here
      several questions: orch answer <id> --q<qid> "<ruling>" --q<qid> "<ruling>"
  orch diff <id>                inspect a run's worktree diff (review diffs are scratch)
      --since-base              compare with the recorded base instead of current trunk
  orch reconcile <id>           write a terminal run row from the persisted reply after a schema move
  orch confinement clear <run-id> --writer TEXT --note TEXT [--tip OID]
      clear a spurious escaped classification, attributing the outside edit and auditing the ruling
  orch review list [--open|--complete] [--project P] [--since ISO] [--json]
  orch review show <id> [--json]
  orch review calibration [<lens> <agent> <model>] [--json]
  orch review pins [--prune]    list reviewed-commit keepalive refs; explicitly prune landed reviews
  orch stop <id>                terminate a running run, reclaim its containers, and keep its worktree
  orch discard <id>             delete that run's worktree (the row stays)
      --force                   also delete a protected branch; bypass a refusing project tool
                                only for a tree marked as created by orch
  orch close-out <id>           release a terminal run's clean worktree and resources; keep its branch
      --non-blocking            return immediately when a cleanup lock is contested
  orch abandon <id> [--note "..."] [--force] retire an asking run and clean up its worktree
  orch sweep [--project <name>] [--force] [--dry-run]
      backstop close-out for terminal trees; clean trees are released and branches kept.
      more than ten kept rows are summarised by reason; --dry-run lists every row
  orch reclassify-failures [--dry-run]
      reclassify stored unclassified vendor quota/auth failures from their error text;
      prints every matched row and before/after counts before writing
  orch health [--days N] [--json] failure classes by count, time, last seen, false-verdict rate and the flake table
  orch epic <TASK-KEY> [--json] one computed scoreboard for an epic and its child tasks
  orch doctor                   agents, local endpoint, routing at a glance
  orch agent add <name> --harness H --backend B [--model M] [--base-url U] [--context-tokens N]
  orch agent set <name> [the add flags] [--jobs JOB,...|any] [--prefer JOB,...] [--max-concurrent N] [--enabled true|false] [--reason TEXT]
  orch agent remove <name>      delete only an agent with no run evidence
  orch agent probe <name>       run reply, file-tool, and structured-output registration probes
  orch agent list [--json]      registered harness + backend + model rows and probe eligibility
  orch project [list] [--json]  the register: where work lives, and what it is built from
      --json                    print one JSON document (the published surface; never orch.db)
      add <path> [--name X] [--stack Y] [--no-canon] [--json]  (--json: one JSON document)
      set <name> [--stack X] [--path P] [--canon|--no-canon] [--settings JSON] [--json]  (--json: one JSON document)
          JSON null deletes that settings key; objects merge deeply
          worktree.readonly_create may provision detached read-only trees at {path} and {base}
          worktree.readonly_notes says what a detached read-only tree can and cannot run
          secretPaths lists sandbox-denied paths; absolute, ~-prefixed, or relative to the main checkout
          worktree.readonly_remove optionally tears them down and receives {path} only
          --allow-incomplete    save a create command missing branch or seed configuration
      remove <name>
  orch init-db                  create the database for a fresh main checkout
  orch migrate [--backfill-spec-sha]
                                apply schema, stamp user_version, re-run backfills including spec_sha
  orch doc list [--scope S] [--subject X] [--json]  (--json: one JSON document)
      show <slug> --scope S [--subject X] [--json]  (--json: one JSON document)
      set <slug> --scope S [--subject X] --title T --reason TEXT [--author NAME] [--delivery inject|demand] (--file F | body on stdin) [--json]  (--json: one JSON document)
      consume <slug> --scope S [--subject X] [--reason TEXT] [--author NAME] [--json]  (--json: one JSON document)
      rm <slug> --scope S [--subject X] --reason TEXT [--author NAME] [--json]  (--json: one JSON document)
      history <scope> <subject|-> <slug> [--json]
      diff <scope> <subject|-> <slug> [<rev-a> [<rev-b>]]
      restore <scope> <subject|-> <slug> <rev> --reason TEXT [--author NAME]
      subjects [--json]  (--json: one JSON document)
      export <dir> | import <dir> --reason TEXT [--author NAME] | brief [--cwd P] | resumes [--cwd P] [--json]
  orch workflow list [--json]  (--json: one JSON document)
      show <slug> [--version N] [--json]  (--json: one JSON document)
      set <slug> --file F --reason TEXT [--author NAME]
      promote <slug> <n> --reason TEXT [--author NAME]
      retire <slug> <n> --reason TEXT [--author NAME]
      fork <slug> [--from N] --reason TEXT [--author NAME]
      versions <slug> [--json]  (--json: one JSON document)
      compose <slug> [--mode M] [--arg k=v]... [--json]  (--json: one JSON document)
      step <slug> <step-slug> [--arg k=v]... [--json]  (--json: one JSON document)
      export <dir> | import <dir> --reason TEXT [--author NAME]
  orch canon check [--cwd P] [--job J] [--all] [--json]
  orch canon diff [--cwd P] [--job J] [--json]
  orch canon eval [--slug S] [--agent A] [--json] [--force]
      --force                   re-run even when canon is unchanged since last pass
  orch canon evals [--json]  (--json: one JSON document)
  orch port baseline show <source> <target> [--json]  (--json: one JSON document)
      baseline set <source> <target> <commit> [--clear] [--json]  (--json: one JSON document)
      skip list <source> <target> [--json]  (--json: one JSON document)
      skip add <source> <target> <candidate> --reason TEXT [--json]  (--json: one JSON document)
      ref list [--all] [--json]  (--json: one JSON document)
      ref show <task-key> [--json]  (--json: one JSON document)
      ref set <task-key> --sources JSON --note TEXT [--json]  (--json: one JSON document)
          sources: [{"project":"name","commits":[...],"paths":[...],"note":"..."}]
      ref resolve <task-key> [--json]  (--json: one JSON document)
      ref delete-error <task-key> [--json]  (--json: one JSON document; correction only)
      doctrine list [--all] [--json]  (--json: one JSON document)
      doctrine add <number> --title T (--file F | body on stdin) [--json]  (--json: one JSON document)
      doctrine retire <number> [--json]  (--json: one JSON document)
  orch mcp [--config]          serve project, doc, and port tools over stdio
  orch jobs [--json]            list job types
  orch agents [--json]          list agents and availability
`)
  process.exit(argv.length ? 1 : 0)
}

/**
 * Help for the command people learn one flag at a time without this page.
 *
 * The job names come from the routing table so adding a job cannot leave the
 * command's own help claiming it does not exist.
 */
function doUsage(): never {
  console.log(`orch do - route a prompt to an external agent and record the run

  orch do <job> [prompt]

  jobs: ${Object.keys(JOBS).join(', ')}
  timeouts (default/ceiling): ${jobTimeoutHelp()}

  --agent <name>   force an agent instead of using the router
  --transport cli|acp  driver seam; default cli. acp covers codex/grok read-only jobs
  --avoid <name,...> exclude agents while routing, unless none remain
  --distinct-from <id,...> exclude models used by earlier runs, unless none remain
  --base <ref>     ${baseHelp('base an implement or fix worktree on this verified git commit')}
  --review <ref>   review this branch or run id (review-lens, safety, craft)
  --carry          carry this checkout's uncommitted work into the worker (off by default)
  --schema <path>  require JSON schema; Codex normalizes it to OpenAI strict mode
  --mcp            require a successful pre-launch MCP tool call
  --mcp=prefer     record MCP call evidence; continue if unavailable or unverified
  --model <name>   override the selected agent's model
  --label <text>   name this run in listings and pending reminders
  --lens <id>      stable identity required by findings-producing review jobs
  --probe          record a calibration run that does not affect routing
  --seed <spec>    choose the project-specific database seed required by some writing jobs
  --seed=<spec>    same; quote a multi-token spec as one value in either form
  --key <KEY-123>  attribute a read-only run, or supply a writing run's required branch key
  --repo <name>    attribute a run launched outside a registered project
  --cwd <path>     resolve and carry from this path as if orch started there
  --file <path>    read the prompt from a file instead of argv or stdin
  --detach         print the run id and return immediately (the default)
  --porcelain      print exactly the run id, for machine callers
  --follow         block and watch the run instead of returning its id
  --no-failover    do not retry vendor failures on another agent
  --no-wait-capacity  take the next eligible agent when the preferred row is at its concurrency cap
  --quiet          print only the reply or run id
  --deliverable T  declare a named reader deliverable (repeatable)
  --timeout N      override the job default, in minutes, within the job ceiling
  --keep-tree      keep a lens or reader worktree instead of reclaiming it
`)
  process.exit(0)
}

function reviewUsage(): never {
  console.log(`orch review - record, inspect, and calibrate independent reviews

  orch review list [--open|--complete] [--project P] [--since ISO] [--json]
  orch review show <id> [--json]
  orch review tier <branch|run-id|from..to> [--json]
  orch review yield [--project P] [--since ISO] [--task KEY|--key KEY] [--lens L] [--agent A] [--json]
  orch review record <run-id>...
  orch review triage <review-id> <finding> <accepted|modified|rejected|skipped>
  orch review complete <review-id>
  orch review pins [--prune]
  orch review calibration [<lens> <agent> <model>] [--json]
`)
  process.exit(0)
}

const projectNames = () => projects().map((p) => p.name).join(', ') || '(none)'

/**
 * A detached command prints its id before its child has necessarily routed.
 * Fan-out launches immediately feed that id into the next command, so briefly
 * wait for the child to record its model instead of turning a normal startup
 * race into "recorded no model". Finished historical rows still fail plainly:
 * there is no truthful model to infer for them.
 */
async function modelForDistinct(id: number): Promise<string> {
  const until = Date.now() + 5_000
  while (true) {
    const row = db().query('SELECT model, status FROM run WHERE id=?').get(id) as
      { model: string | null; status: string } | null
    if (!row) throw new Error(`no run ${id} named by --distinct-from`)
    if (row.model) return row.model
    if (row.status !== 'running' || Date.now() >= until) {
      throw new Error(`run ${id} recorded no model for --distinct-from to exclude`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/**
 * Parse the exclusions that make a fan-out route different from the default.
 *
 * `do` and `pick` must reject the same malformed preview: when this validation
 * lived in the execution case, `pick` accepted both flags from VALUE_FLAGS and
 * silently reported the unconstrained route. Keeping the run lookup here also
 * means a preview cannot assign a different meaning to a missing or unfinished
 * run than the command it previews.
 */
async function routeConstraints(agent?: string): Promise<{
  avoid: string[]; distinctModels: string[]
}> {
  const avoid = flag('avoid')?.split(',').filter(Boolean) ?? []
  for (const name of avoid) {
    if (!AGENTS[name]) throw new Error(`unknown agent "${name}" in --avoid`)
  }
  // A pin outranks distinctness completely: its run history is not routing
  // input once the caller has already selected the agent.
  const distinctIds = agent
    ? []
    : (flag('distinct-from')?.split(',').filter(Boolean) ?? []).map(Number)
  if (distinctIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Error('--distinct-from expects comma-separated run ids')
  }
  const distinctModels = await Promise.all(distinctIds.map(modelForDistinct))
  if (agent && avoid.includes(agent)) {
    throw new Error(`--agent ${agent} contradicts --avoid ${agent}`)
  }
  return { avoid, distinctModels }
}

function positionalMessage(rest: string[], allowDashPositionals = false): string[] {
  // A boolean switch does not consume the next argument, so only skip the one
  // after a flag that actually takes a value — otherwise `--quiet <prompt>`
  // silently discards the prompt. Unrecognized `--…` tokens after the run id
  // are message text on answer/tell/continue (DEV-242 for --seed; the same
  // defect for a ruling). `do` still treats a leading `--` as a flag.
  return rest.filter((a, i) => {
    const prev = rest[i - 1] ?? ''
    if (VALUE_FLAGS.has(prev)) return false
    if (a === '--file' || a.startsWith('--file=')) return false
    if (a === '--follow' || a === '--detach' || a === '--quiet') return false
    if (!allowDashPositionals && a.startsWith('--')) return false
    return true
  })
}

function decodeWorkerBytes(bytes: Uint8Array, source: string): string {
  const utf8At = invalidUtf8Offset(bytes)
  if (utf8At !== null) {
    throw new Error(`invalid UTF-8 in ${source} at byte offset ${utf8At}`)
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

function readWorkerFile(path: string): string {
  return decodeWorkerBytes(readFileSync(path), path)
}

function assertWorkerText(
  text: string, noun: string, workingForms: string, argvLimit?: number,
): void {
  refuseMisparsedMessage(text, noun, workingForms)
  const nulAt = nulByteOffset(text)
  if (nulAt !== null) {
    throw new Error(
      `${noun} contains a NUL at byte offset ${nulAt}\nworking forms:\n${workingForms}`,
    )
  }
  if (argvLimit !== undefined) {
    const n = Buffer.byteLength(text, 'utf8')
    if (n > argvLimit) {
      throw new Error(
        `${noun} is ${n} bytes; this agent's resume transport is bounded at ${argvLimit} bytes\n` +
        `working forms:\n${workingForms}`,
      )
    }
  }
}

function argvResumeLimit(agentName: string): number | undefined {
  const agent = AGENTS[agentName]
  if (!agent?.resumeArgv) return undefined
  return resumePromptByteLimit(agent)
}

/**
 * One reader for the free-text body that reaches a worker: positional text,
 * or --file PATH, or stdin when neither is given and stdin is not a TTY.
 */
async function readMessageText(opts: {
  missing: string
  exclusive?: string
  optional?: boolean
  allowDashPositionals?: boolean
  sources?: { commandFile?: string; positionals: string[] }
}): Promise<string | undefined> {
  const commandFile = opts.sources?.commandFile ?? flag('file')
  const positional = opts.sources
    ? opts.sources.positionals
    : positionalMessage(argv.slice(2), opts.allowDashPositionals)
  if (commandFile && positional.length && opts.exclusive) throw new Error(opts.exclusive)
  if (commandFile) return readWorkerFile(commandFile); if (positional.length) return positional.join(' ')
  if (!process.stdin.isTTY) {
    return decodeWorkerBytes(new Uint8Array(await Bun.stdin.bytes()), 'stdin')
  }
  if (opts.optional) return undefined
  throw new Error(opts.missing)
}

const runAnswerHelpers = {
  argvResumeLimit, assertWorkerText, readWorkerFile, readMessageText,
  presentation: { dur, scoreHint, argvResumeLimit, printRunId },
}

async function readPrompt(): Promise<string> {
  return (await readMessageText({
    missing: 'no prompt: pass it as an argument, via --file, or on stdin',
  }))!
}

/**
 * Everything below throws plain Errors for things a person did, not for bugs:
 * an unknown run, a job that does not exist, a verdict word that is not one of
 * the six. Bun prints an uncaught throw as a stack trace with a code frame,
 * which buries a message whose whole job is to be read — the scoring help is
 * eight lines of vocabulary and it was arriving under a heading pointing at
 * cli.ts:110. Wrapped so the message is the output.
 */
/**
 * Reachability is checked for every command that ROUTES OR REPORTS A ROUTE.
 *
 * `orch do` probed and the reporting commands did not, so during the
 * 2026-08-31 outage `orch pick file-question` answered `-> qwen-local` while
 * `orch do file-question` correctly sent the work to codex. Two commands
 * disagreeing about the same question is the failure this codebase already has
 * a rule against — one score, reported the same everywhere — and it had grown
 * back in a new place.
 *
 * Done here rather than in each case, because the list of commands that surface
 * eligibility is the thing to keep correct, and a `case` that forgets its own
 * await is invisible until an outage. `run()` probes independently: it is called
 * programmatically too, and must be safe without this.
 */
try {

validateCliArgs(argv)
if ((argv.includes('--help') || argv.includes('-h')) && cmd && cmd !== '--help' && cmd !== '-h') {
  if (cmd === 'do') {
    await loadJobs()
    doUsage()
  }
  if (cmd === 'review') reviewUsage()
  const { commandShape } = await import('./args.ts')
  const selected = commandShape(argv)
  if (selected) {
    console.log(selected.shape.usage)
    process.exit(0)
  }
}

switch (cmd) {
  case 'flake': console.log((await import('./gate-policy.ts')).flakeCommand(argv.slice(1), writableDb())); break
  case 'init-db': {
    const { initializeDatabase } = await import('./db.ts')
    console.log(`initialized ${initializeDatabase()}`)
    break
  }

  case 'migrate': {
    const { backfillSpecSha, migrateDatabase } = await import('./db.ts')
    const migrated = migrateDatabase()
    if (migrated.versions.length === 0) {
      console.log(`schema already current: ${migrated.path}`)
    } else {
      console.log(`migrated ${migrated.path}`)
      for (const version of migrated.versions) console.log(`  applied ${version}`)
    }
    const backfilled = backfillSpecSha()
    console.log(`spec_sha backfill: ${backfilled.updated} updated, ${backfilled.missing} prompt files missing`)
    break
  }

  case 'reconcile': {
    const { reconcileRun } = await import('./run-artifacts.ts')
    const id = Number(argv[1])
    if (!id) throw new Error('orch reconcile <id>')
    console.log(reconcileRun(id))
    break
  }

  case 'confinement': {
    if (argv[1] !== 'clear') {
      throw new Error('orch confinement clear <run-id> --writer <text> --note <text> [--tip <current-tip>]')
    }
    const id = Number(argv[2])
    const writer = flag('writer')?.trim()
    const note = flag('note')?.trim()
    if (!id || !writer || !note) {
      throw new Error('orch confinement clear <run-id> --writer <text> --note <text> [--tip <current-tip>]')
    }
    clearConfinement(id, { writer, note, tip: flag('tip')?.trim() ?? null }, { log: console.log })
    break
  }
  case 'contract': {
    await Promise.all([loadJobs(), loadContract()])
    const jobName = argv[1]
    if (!jobName) throw new Error('orch contract <job>')
    const selected = job(jobName)
    const preamble = selected.needs.writesRepo
      ? WORKER_PREAMBLE
      : selected.needs.readsRepo ? READONLY_PREAMBLE : NO_REPO_PREAMBLE
    process.stdout.write(
      (selected.findings ? `${REVIEW_SEVERITY_INSTRUCTION}\n\n` : '') +
      preamble + '\n\n' + jobBoundInstructionForContract(selected) + '\n',
    )
    break
  }

  case 'doc': {
    const sub = argv[1] ?? 'list'; await docCommand(sub, argv, { has, flag }, {
      log: console.log, error: console.error, write: (value) => process.stdout.write(value),
      stdinText: () => Bun.stdin.text(), stdinIsTTY: process.stdin.isTTY, cwd: process.cwd,
    })
    break
  }
  case 'canon': {
    await loadJobs()
    const { allInjectChecks, allNumericLiterals, compilePack, diffPack, findingsForPack } = await import('./canon.ts')
    const sub = argv[1]
    const cwd = flag('cwd') ?? process.cwd()
    const jobName = flag('job') ?? 'understand'
    if (sub === 'eval') {
      const { runCanonEvals } = await import('./evals.ts')
      const rows = await runCanonEvals({
        slug: flag('slug'), agent: flag('agent'), force: has('force'),
      })
      if (has('json')) console.log(JSON.stringify(rows))
      else {
        for (const row of rows) {
          const verdict = row.skipped ? 'skip' : row.pass ? 'pass' : 'fail'
          console.log(`${row.slug}  ${row.agent}  ${verdict}  ${row.why}  ${row.canonSha}`)
        }
      }
      if (rows.some((row) => !row.skipped && row.pass === false)) process.exitCode = 1
      break
    }
    if (sub === 'evals') {
      const { canonEvalsReport } = await import('./evals.ts')
      const report = canonEvalsReport()
      if (has('json')) console.log(JSON.stringify(report))
      else {
        for (const row of report.latest) {
          const good = report.last_known_good.find((item) => item.slug === row.slug && item.agent === row.agent)
          console.log(
            `${row.slug}  ${row.agent}  ${row.pass ? 'pass' : 'fail'}  ${row.why}  ${row.canon_sha}` +
            (good ? `  last-pass ${good.canon_sha}` : '  last-pass none'),
          )
        }
      }
      break
    }
    if (sub === 'check') {
      const pack = compilePack({ job: jobName, cwd })
      const rows = has('all') ? allInjectChecks() : findingsForPack(pack)
      const findings = rows.flatMap((row) => row.findings.map((finding) => ({ doc: row.doc, ...finding })))
      const numericReport = allNumericLiterals(cwd)
      const numericLiterals = numericReport.numericLiterals.filter((hit) => hit.classification === 'RESTATED')
      const result = { pack: { job: pack.job, project: pack.project, bytes: pack.bytes,
        budgetBytes: pack.budgetBytes, sha256: pack.sha256 }, docs: rows, findings,
        numericLiterals, canonFiles: numericReport.canonFiles }
      if (has('json')) console.log(JSON.stringify(result))
      else {
        console.log(`canon: ${pack.bytes}/${pack.budgetBytes} bytes`)
        for (const row of rows.filter((row) => row.findings.length)) {
          console.log(`${row.doc.scope}/${row.doc.subject ?? '_'}/${row.doc.slug} revision ${row.doc.revisionId}`)
          for (const finding of row.findings) console.log(`  ${finding.kind}: ${finding.message}`)
        }
        console.log(`canon files: read ${numericReport.canonFiles.read.join(', ') || 'none'}` +
          `; missing ${numericReport.canonFiles.missing.join(', ') || 'none'}`)
        console.log('numeric literals')
        for (const hit of numericLiterals) {
          console.log(`  ${hit.source}  ${hit.numeral}  ${hit.sentence}`)
        }
      }
      if (findings.length) process.exitCode = 1
      break
    }
    if (sub === 'diff') {
      const result = diffPack({ job: jobName, cwd })
      if (has('json')) console.log(JSON.stringify(result))
      else {
        console.log(`canon ${result.job}/${result.project ?? '_'}: ${result.bytesDelta >= 0 ? '+' : ''}${result.bytesDelta} bytes`)
        for (const doc of result.added) console.log(`  added ${doc.scope}/${doc.subject ?? '_'}/${doc.slug} revision ${doc.revisionId}`)
        for (const doc of result.removed) console.log(`  removed ${doc.scope}/${doc.subject ?? '_'}/${doc.slug} revision ${doc.revisionId}`)
        for (const doc of result.changed) console.log(`  changed ${doc.slug} revision ${doc.fromRevision} -> ${doc.toRevision}`)
      }
      break
    }
    throw new Error('unknown: orch canon. Try check | diff | eval | evals')
  }

  case 'port': {
    const group = argv[1]
    const action = argv[2]
    const commandFlags = { has, flag }
    const presentation = {
      log: console.log, writeStdout, exitCode: (code: number) => { process.exitCode = code },
    }
    await portCommand(group, action, argv, commandFlags, presentation)
    break
  }

  case 'mcp': {
    if (has('config')) {
      console.log(JSON.stringify({ mcpServers: { orch: {
        command: resolve(new URL('../../bin/orch', import.meta.url).pathname), args: ['mcp'],
      } } }, null, 2))
      break
    }
    const { serveDocsMcp } = await import('./mcp.ts')
    await serveDocsMcp()
    break
  }

  case 'workflow': {
    await Promise.all([loadJobs(), loadWorkflows()])
    const sub = argv[1]
    const json = has('json')
    const print = (value: unknown, line?: string) => console.log(json ? JSON.stringify(value) : (line ?? JSON.stringify(value, null, 2)))
    const numberFlag = (name: string) => {
      const value = flag(name)
      if (value === undefined) return undefined
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`)
      return n
    }
    const positionNumber = (value: string | undefined) => {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1) throw new Error('version must be a positive integer')
      return n
    }
    const workflowArgs = () => Object.fromEntries(flagValues(argv, 'arg').map((pair) => {
      const at = pair.indexOf('=')
      if (at < 1) throw new Error(`invalid --arg "${pair}"; use k=v`)
      return [pair.slice(0,at),pair.slice(at+1)]
    }))
    if (sub === 'list') {
      const workflows = listWorkflows()
      print(workflows, workflows.map((workflow) =>
        `${workflow.slug}  ${workflow.title}  production=${workflow.production_n ?? '-'} draft=${workflow.draft_n ?? '-'}`,
      ).join('\n'))
    }
    else if (sub === 'show') print(showWorkflow(argv[2]!,numberFlag('version')))
    else if (sub === 'set') {
      const file=flag('file'); if (!file) throw new Error('file is required')
      print(setWorkflow(argv[2]!,JSON.parse(readFileSync(file,'utf8')),flag('reason'),flag('author')))
    }
    else if (sub === 'promote') print(promoteWorkflow(argv[2]!,positionNumber(argv[3]),flag('reason'),flag('author')))
    else if (sub === 'retire') print(retireWorkflow(argv[2]!,positionNumber(argv[3]),flag('reason'),flag('author')))
    else if (sub === 'fork') print(forkWorkflow(argv[2]!,numberFlag('from'),flag('reason'),flag('author')))
    else if (sub === 'versions') print(workflowVersions(argv[2]!))
    else if (sub === 'compose') {
      const result=composeWorkflow(argv[2]!,flag('mode'),workflowArgs())
      if (json) print(result)
      else {
        console.log(`${result.workflow.title} — ${result.mode?.title ?? 'choose a mode'}`)
        if (result.needs.mode) for (const mode of result.needs.mode) console.log(`${mode.slug}: ${mode.entry}`)
        if (result.needs.arguments) console.log(`missing required arguments: ${result.needs.arguments.join(', ')}`)
        for (const step of result.steps) console.log(`${step.n}. ${step.slug} — ${step.title} [job=${step.job ?? '-'} autonomy=${step.autonomy} gate=${step.gate ?? '-'}]`)
      }
      if (Object.keys(result.needs).length) process.exitCode=2
    }
    else if (sub === 'step') {
      const step = getWorkflowStep(argv[2]!, argv[3]!, workflowArgs())
      print(step, step.body)
    }
    else if (sub === 'export') exportWorkflows(argv[2]!)
    else if (sub === 'import') print(importWorkflows(argv[2]!,flag('reason'),flag('author')))
    else throw new Error('unknown: orch workflow. Try list | show | set | promote | retire | fork | versions | compose | step | export | import')
    break
  }

  case 'lens': {
    const { listLenses,showLens,setLens,listProfiles,showProfile,setProfile }=await import('./lenses.ts')
    const sub=argv[1]; const json=has('json'); const emit=(value:unknown,line?:string)=>console.log(json?JSON.stringify(value):(line??JSON.stringify(value,null,2)))
    const enabled=()=>{const value=flag('enabled');if(value!=='true'&&value!=='false')throw new Error('--enabled must be true or false');return value==='true'}
    const jsonSource=(inline:string,file:string,what:string)=>{const a=flag(inline),p=flag(file);if((a===undefined)===(p===undefined))throw new Error(`pass exactly one of --${inline} or --${file}`);return p?readFileSync(p,'utf8'):a!}
    if(sub==='list'){const rows=listLenses();emit(rows,rows.map(x=>`${x.id}  v${x.version}  ${x.enabled?'enabled':'disabled'}  ${x.title}`).join('\n'))}
    else if(sub==='show'){const row=showLens(argv[2]!);if(!row)throw new Error(`no lens "${argv[2]}"`);emit(row)}
    else if(sub==='set'){
      const id=argv[2],title=flag('title'),question=flag('question'),excludes=flag('excludes'),reason=flag('reason')
      if(!id||title===undefined||question===undefined||excludes===undefined||!reason?.trim())throw new Error('lens set requires id, title, question, excludes, enabled, slots, and reason')
      emit(setLens({id,title,question,excludes,slots:jsonSource('slots','slots-file','slots'),enabled:enabled(),reason}))
    } else if(sub==='profile'){
      const action=argv[2],id=argv[3]
      if(action==='list'){const rows=listProfiles(id);emit(rows,rows.map(x=>`${x.lens_id}  ${x.axis}/${x.name}  v${x.version}  ${x.enabled?'enabled':'disabled'}`).join('\n'))}
      else if(action==='show'){const row=showProfile(id!,flag('axis')!,flag('name')!);if(!row)throw new Error('no such lens profile');emit(row)}
      else if(action==='set'){const reason=flag('reason');if(!id||!flag('axis')||!flag('name')||!reason?.trim())throw new Error('lens profile set requires lens, axis, name, enabled, body, and reason');emit(setProfile({lensId:id,axis:flag('axis')!,name:flag('name')!,body:jsonSource('body','body-file','body'),enabled:enabled(),reason}))}
      else throw new Error('unknown: orch lens profile. Try list | show | set')
    } else throw new Error('unknown: orch lens. Try list | show | set | profile')
    break
  }

  case 'issue': {
    const key = argv[1]
    if (!key) throw new Error('orch issue <TASK-KEY>')
    const { workIssue } = await import('./issue.ts')
    await workIssue(key.toUpperCase())
    break
  }

  case 'note': {
    const noteText = argv[1]
    if (!noteText?.trim()) throw new Error('orch note <text> [--same-as ID|--new]')
    const { fileNote } = await import('./mcp.ts')
    const same = flag('same-as')
    const result = await fileNote({ text: noteText, ...(same ? { same_as: Number(same) } : {}), new: has('new') })
    console.log(result.output)
    break
  }

  case 'do': {
    await Promise.all([loadJobs(), loadAgents(), loadRoute(), loadRun(), loadWorktree(), loadContract(), loadTransport()])
    await ensureLocalHealth()
    const jobName = argv[1]
    if (!jobName) usage()
    if (jobName === '--help' || jobName === '-h') doUsage()
    const porcelain = has('porcelain')
    if (porcelain && has('follow')) {
      throw new Error('--porcelain cannot be combined with --follow')
    }
    const requested = job(jobName)
    const selectedRow = flag('agent') ? AGENTS[flag('agent')!] : undefined
    const transportFlag = flag('transport')
    const transportExplicit = transportFlag !== undefined || Boolean(process.env.ORCH_TRANSPORT)
    const transport = !transportExplicit && selectedRow
      ? selectedRow.defaultTransport
      : resolveTransportName(transportFlag)
    if (transport === 'acp') {
      assertAcpAllowed(jobName, flag('agent'))
      assertAcpReady(flag('agent') ?? 'codex')
    }
    const agent = selectAgentForTransport(transport, flag('agent'))
    const requestedCwd = flag('cwd')
    if (requestedCwd && !existsSync(requestedCwd)) throw new Error(`--cwd does not exist: ${requestedCwd}`)
    const callerCwd = requestedCwd ? realpathSync(requestedCwd) : process.cwd()
    if (requestedCwd && !projectAt(callerCwd)) throw new Error(`--cwd is not inside a registered project: ${callerCwd}`)
    const explicitRepo = flag('repo')
    if (explicitRepo && !projectByName(explicitRepo)) {
      throw new Error(`unknown repo "${explicitRepo}". Registered: ${projectNames()}`)
    }
    // Project-required inputs are knowable before the prompt is read. Checking
    // them afterwards made a missing key pay for stdin and run setup first.
    const base = flag('base')
    const reviewRef = flag('review')
    if (base) {
      if (jobName !== 'implement' && jobName !== 'fix') {
        throw new Error('--base is only valid for the implement and fix jobs')
      }
      resolveBase(callerCwd, base)
    }
    const seed = preflight(
      jobName, callerCwd, flag('seed'), flag('key'), base, false, false, flag('lens'),
      reviewRef, has('carry'), explicitRepo,
    )
    if (requested.needs.readsRepo) warnCallerDrift(callerCwd, base)
    if (requested.findings && requested.needs.readsRepo && !reviewRef) {
      console.error(`! ${implicitReviewWarning(callerCwd)}`)
    }
    const schema = flag('schema')
    // An unpinned run may route to Codex, so its schema has to be suitable
    // before detach() claims a row. An explicitly pinned non-Codex agent keeps
    // its own schema dialect and reads the caller's original file unchanged.
    if (schema && (!flag('agent') || flag('agent') === 'codex')) readStrictCodexSchema(schema)
    const deliverables = flags('deliverable')
    if (deliverables.length && !isReaderJob(jobName)) {
      throw new Error('--deliverable is only valid for diagnose, understand, and file-question')
    }
    const timeoutRaw = flag('timeout')
    const timeoutMinutes = timeoutRaw === undefined ? undefined : Number(timeoutRaw)
    if (timeoutMinutes !== undefined) resolveJobTimeoutMs(requested, 1, timeoutMinutes)
    if (has('keep-tree') && !reclaimsTreeByDefault(jobName)) {
      throw new Error('--keep-tree is only valid for lens and reader jobs')
    }
    const keepTree = has('keep-tree')
    const { avoid, distinctModels } = await routeConstraints(flag('agent'))
    if (!porcelain && !explicitRepo && !projectAt(callerCwd)) {
      console.error(
        `! this run will not be attributed to any project; use --repo <name> ` +
        `(registered: ${projectNames()})`,
      )
    }
    if (!porcelain && !has('carry') && requested.needs.readsRepo &&
        checkoutHasUncommittedWork(callerCwd)) {
      console.error(
        '! this checkout has uncommitted work that will not be carried into the worker.\n' +
        '  pass --carry to send it with the run.',
      )
    }
    const prompt = await readPrompt()
    if (!prompt.trim()) throw new Error('empty prompt')
    const conflicts = jobName === 'implement' ? contractConflicts(prompt) : []

    // A fan-out cannot be run synchronously, and that is not a caller's problem
    // to solve.
    //
    // Seven review lenses is the NORMAL shape of a review here, and each takes
    // about six minutes. Run in the foreground they outlive an agent harness's
    // command timeout and the whole process group is killed; detached by the
    // caller they die with the wrapper shell, because a spawned agent has no
    // way to outlive the shell that started it. Both were tried, in a real
    // review, and both lost the work.
    //
    /**
     * EVERY JOB DETACHES BY DEFAULT.
     *
     * In the seven days through 2026-09-02, 59 foreground runs died as
     * "interrupted, exit 143, empty output" when the caller's shell was killed:
     * 24 review-lens, 24 understand, 6 file-question, and 5 other runs. Only 2
     * were writing jobs, which already detached by default. The same deaths
     * left another 35 runs stale. Claude's harness bounds foreground commands
     * at 120 or 600 seconds, while review-lens allows 30 minutes and cannot fit
     * inside that shell; one affected session had to relaunch it with its own
     * backgrounding.
     *
     * `--follow` keeps the existing foreground experience for someone who
     * wants to watch: the run still detaches underneath, and this process waits.
     */
    const detachByDefault = !has('follow')
    if (has('detach') || detachByDefault) {
      const id = await detach(jobName, prompt, {
        agent, schema, label: flag('label'), lens: flag('lens'),
        mcp: requestedMcp(), model: flag('model'), probe: has('probe'), seed, key: flag('key'),
        repo: explicitRepo, base, avoid, distinctModels,
        ...(transportExplicit ? { transport } : {}),
        noFailover: has('no-failover'), noWaitCapacity: has('no-wait-capacity'),
        carry: has('carry'), review: reviewRef, cwd: callerCwd,
        deliverables, timeoutMinutes, keepTree,
      })
      if (!porcelain) warnImplementContractConflicts(conflicts, id)
      printRunId(id)
      if (!has('quiet') && !porcelain) {
        console.error(`detached as run ${id}: orch wait ${id}, then orch result ${id}`)
      }
      if (detachByDefault && !has('detach') && !has('quiet') && !porcelain) {
        console.error(
          `\n— ${jobName} detached by default; collect it when it finishes.` +
          `\n  orch wait ${id}      then:  orch result ${id}` +
          `\n  orch inbox          if it stops to ask` +
          `\n  --follow            to watch it here instead`,
        )
      }
      break
    }

    /**
     * The foreground path runs DETACHED too, and then watches the row.
     *
     * It used to spawn the agent as a child of this process, which meant the
     * work died with the caller. That is not hypothetical: an `orch do` left in
     * the foreground outlives an agent harness's command timeout, the harness
     * kills the process group, run()'s signal handler forwards SIGTERM to the
     * agent, and a run that was minutes from an answer is destroyed having
     * written nothing. 26 runs in this database - 8% of every run ever made -
     * died exactly that way, and the same kill was reproduced twice while this
     * was being written.
     *
     * Detaching first means the worker owns the row and finishes regardless. A
     * killed caller now loses only its own view of the output: the run
     * completes, records its verdict, and `orch run <id>` still has the answer.
     * The wait is bounded by the agent's own timeout plus a margin, so a
     * genuinely stuck run still returns control rather than hanging for ever.
     */
    const id = await detach(jobName, prompt, {
      agent, schema, label: flag('label'), lens: flag('lens'),
      mcp: requestedMcp(), model: flag('model'), probe: has('probe'), seed, key: flag('key'),
      repo: explicitRepo, base, avoid, distinctModels,
      ...(transportExplicit ? { transport } : {}),
      noFailover: has('no-failover'), carry: has('carry'), review: reviewRef, cwd: callerCwd,
      deliverables, timeoutMinutes, keepTree,
    })
    warnImplementContractConflicts(conflicts, id)

    await follow(id, has('quiet'))
    break
  }

  case 'review': {
    const sub = argv[1]
    const commandFlags = { has, flag }
    const presentation = {
      log: console.log, usage: reviewUsage,
    }
    await reviewCommand(sub, argv, commandFlags, presentation)
    break
  }

  // The dashboard surface, published for hub to render.
  //
  // hub cannot import from this concern - the boundary check forbids it, and a
  // shared database would make two concerns one - so what the orchestrator's
  // own page used to fetch over HTTP is emitted here instead.
  case 'state': {
    const { state } = await import('./serve.ts')
    const days = flag('days') ? Number(flag('days')) : null
    console.log(JSON.stringify(state(days)))
    break
  }

  case 'run': {
    const id = Number(argv[1])
    if (!id) usage()
    const { runDetail } = await import('./serve.ts')
    const d = runDetail(id, has('receipt'))
    if (!d) throw new Error(`no run ${id}`)
    console.log(JSON.stringify(d))
    break
  }

  case 'search': {
    const query = argv[1]
    if (!query) usage()
    const limitText = flag('limit')
    const limit = limitText === undefined ? 20 : Number(limitText)
    const { searchRecords } = await import('./search.ts')
    const found = searchRecords(db(), query, limit, has('full'))
    if (has('json')) {
      console.log(JSON.stringify(found))
      break
    }
    if (!found.results.length) {
      console.log(`no record matches for "${found.query}"`)
    } else {
      for (const result of found.results) {
        const task = result.task_key ? ` · ${result.task_key}` : ''
        console.log(
          `${result.source} ${result.record_id} · run ${result.run_id}${task} · ${result.match}\n` +
          (result.content === undefined ? `  ${result.snippet}` : result.content),
        )
      }
      if (found.truncated) console.log(`\nmore matches omitted; increase --limit to see them`)
    }
    if (found.unavailable_outputs) {
      console.log(
        `\n${found.unavailable_outputs} saved run output${found.unavailable_outputs === 1 ? ' is' : 's are'} no longer available and could not be searched`,
      )
    }
    break
  }

  case 'tell': {
    const id = Number(argv[1])
    if (!id) usage()
    const sources = parseWorkerMessageArgs(argv.slice(2), {
      usage: 'orch tell <run-id> ["<message>"] [--file PATH] [--ping]',
      booleans: ['--ping'],
    })
    const body = (await readMessageText({
      missing: 'no message: pass it as an argument, via --file, or on stdin',
      exclusive: 'pass the message either positionally or with --file, not both',
      sources,
    }))!
    assertWorkerText(body, 'message', TELL_WORKING_FORMS)
    const { tellRun } = await import('./mailbox.ts')
    const message = tellRun(id, body)
    console.log(
      `queued message ${message.id} for run ${message.root_run_id} ` +
      `(turn ${message.run_id}); it has not been read`,
    )
    if (has('ping')) {
      const { formatPeek, peekRun } = await import('./events.ts')
      console.log(formatPeek(peekRun(message.run_id)))
    }
    break
  }

  case 'peek': {
    const id = Number(argv[1])
    if (!id) usage()
    const eventsFlag = flag('events')
    const events = eventsFlag === undefined ? undefined : Number(eventsFlag)
    if (events !== undefined && (!Number.isInteger(events) || events < 0)) {
      throw new Error('--events must be a non-negative integer')
    }
    const { formatPeek, peekRun } = await import('./events.ts')
    const summary = peekRun(id, { events })
    if (has('json')) console.log(JSON.stringify(summary))
    else console.log(formatPeek(summary))
    break
  }

  case 'result': {
    await loadJobs()
    collectResult(db(), argv, scoreSuffix)
    const id = Number(argv[1])
    const chain = resolveFailover(db(), id)
    const row = db().query(
      `SELECT job, status, latency_ms, probe, output_path FROM run WHERE id=?`,
    ).get(chain.finalId) as {
      job: string; status: string; latency_ms: number | null; probe: number
      output_path: string | null
    }
    const warning = thinOutputWarning(row)
    if (warning) console.error(warning)
    break
  }

  case 'wait': {
    await collectWait(db(), argv, reapStale)
    break
  }

  case 'retry': {
    await Promise.all([loadJobs(), loadAgents(), loadRoute(), loadRun(), loadWorktree(), loadContract()])
    const id = Number(argv[1])
    if (!id) usage()
    await retryRun(id, { agent: flag('agent'), model: flag('model'), flags: {
      detach: has('detach'), follow: has('follow'), quiet: has('quiet'),
    } }, runAnswerHelpers)
    break
  }
  /**
   * The deliverable of a writing run, which is the DIFF and not the prose.
   *
   * `orch result` prints what the agent SAID; this prints what it DID, and the
   * two are different claims. An implementation worker that reports "added the
   * bucket and updated the tests" has made an assertion the architect has to
   * check, and checking it against the agent's own summary checks nothing.
   */
  /**
   * Questions waiting on a ruling.
   *
   * The counterpart to `orch pending`: that one raises work nobody judged, this
   * one raises work nobody UNBLOCKED. Both exist because the failure mode is
   * the same — a step that is easy to skip because the thing it serves has
   * already moved on — and here it is worse, because a worker waiting for a
   * ruling is holding a whole session open with everything it read still in it.
   *
   * Defaults to questions for the project containing cwd, because that is the
   * useful visibility scope. Authority is narrower: only the session that
   * dispatched a run can answer it. `--all` widens visibility, never ownership.
   */
  /**
   * The stdio MCP server a worker calls back into. Not for humans.
   *
   * Registered once per agent (`orch setup-ask`), so its ask, message, and
   * checkpoint tools can be called mid-task. It speaks
   * JSON-RPC on stdin/stdout and must therefore print NOTHING else, which is
   * why it is a subcommand rather than a flag on an existing one — a stray
   * banner or hint on stdout is a protocol violation the client reports as a
   * parse error, not as the friendly message it was meant to be.
   */
  /**
   * The project register: where work lives, what it is built from, how its
   * tracker speaks.
   *
   * This exists so the code knows the SHAPE of a project and none of the
   * instances. Everything here used to know four repository names and one
   * person's home directory, which is fine for one machine and is exactly what
   * makes a tool unadoptable by anyone else.
   */
  case 'project': {
    const sub = argv[1] ?? 'list'; projectCommand(sub, argv, { has, flag }, { log: console.log, cwd: process.cwd })
    break
  }
  case 'ask-server': {
    const { serveAsk } = await import('./ask.ts')
    await serveAsk()
    break
  }

  /**
   * Register the ask-server with each agent that can reach it.
   *
   * Idempotent by construction — `mcp add` on both CLIs overwrites an existing
   * entry of the same name — so this is safe to re-run, which matters because
   * the honest way to find out whether registration survived a CLI upgrade is
   * to do it again.
   */
  case 'setup-ask': {
    await loadAgents()
    const cmd = [process.execPath, new URL('cli.ts', import.meta.url).pathname, 'ask-server']
    // Every agent declaring `mcp`, not a hardcoded pair. qwen declares it and
    // was being left out, so the one free agent that could have used the live
    // channel never received it — while the comment claimed otherwise.
    const registrars: Record<string, string[]> = {
      codex: ['mcp', 'add', 'orch-ask', '--', ...cmd],
      grok: ['mcp', 'add', 'orch-ask', '--', ...cmd],
      // Qwen Code keeps MCP servers in its settings file rather than behind a
      // subcommand, so it is reported as needing a manual line rather than
      // silently skipped.
    }
    const manual = Object.values(AGENTS)
      .filter((a) => a.caps.mcp && !(a.bin in registrars))
      .map((a) => a.name)
    const runs: [string, string[]][] = Object.entries(registrars)
    for (const [bin, args] of runs) {
      const p = Bun.spawnSync([bin, ...args], { stdout: 'pipe', stderr: 'pipe' })
      const detail = (p.stdout.toString() + p.stderr.toString()).trim().split('\n')[0] ?? ''
      console.log(`${p.exitCode === 0 ? 'ok  ' : 'FAIL'} ${bin}: ${detail || `exit ${p.exitCode}`}`)
    }
    if (manual.length) {
      console.log(
        `\nnot registered automatically: ${manual.join(', ')} — add orch-ask to their own` +
        `\nMCP settings by hand, or they fall back to the asking protocol.`,
      )
    }
    console.log(
      '\nA worker can now call ask_orchestrator, message_orchestrator, and ' +
      'check_orchestrator_messages mid-task.' +
      '\nAgents without it fall back to returning status "asking", which still works.',
    )
    break
  }

  /**
   * What is stopping agents doing their work, counted.
   *
   * The counterpart to `orch inbox`: that raises decisions only the architect
   * can make, this raises conditions only the ENVIRONMENT can fix. Both were
   * arriving already and neither was visible — a blocker turns up alongside a
   * run that otherwise succeeded, so nothing about the run looked wrong.
   *
   * Ordered by RECURRENCE rather than recency, because that is the number that
   * decides anything: one denied Docker socket is an anecdote and forty is a
   * machine to fix, and the whole reason these went unaddressed is that each
   * worker met the problem once, worked around it, and moved on.
   */
  case 'blockers': {
    const days = Number(flag('days') ?? 14)
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    const rows = db().query(
      `SELECT COALESCE(b.kind, b.what) AS kind, b.source,
              COUNT(*) AS n, COUNT(DISTINCT r.repo) AS repos,
              MAX(b.at) AS last_at,
              MIN(b.why) AS example,
              GROUP_CONCAT(DISTINCT r.agent) AS agents
         FROM blocker b JOIN run r ON r.id = b.run_id
        WHERE b.at >= ?
        GROUP BY 1, 2
        ORDER BY n DESC`,
    ).all(since) as {
      kind: string; source: string; n: number; repos: number
      last_at: string; example: string | null; agents: string | null
    }[]

    /**
     * PUBLISHED, because hub cannot import this concern or open orch.db.
     *
     * The same contract `orch state` and `orch project list --json` already
     * serve: what another concern needs is emitted here rather than reached
     * for. Field names are the query's, so a reader of this command and a
     * reader of the table see the same words.
     */
    if (has('json')) {
      console.log(JSON.stringify({
        days,
        blockers: rows.map((r) => ({
          kind: r.kind,
          source: r.source,
          runs: r.n,
          projects: r.repos,
          agents: r.agents ? r.agents.split(',') : [],
          lastAt: r.last_at,
          example: r.example,
        })),
      }))
      break
    }

    if (!rows.length) {
      console.log(`nothing reported in ${days} days`)
      break
    }
    console.log(`what stopped agents working, last ${days} days:\n`)
    for (const r of rows) {
      console.log(
        `${String(r.n).padStart(4)}x  ${r.kind}` +
        `  (${r.source}, ${r.repos} project${r.repos === 1 ? '' : 's'}, ${r.agents ?? '—'})`,
      )
      if (r.example) console.log(`        ${r.example.slice(0, 150)}`)
    }
    console.log(
      `\nThese are environment problems, not agent failures — an agent that hit one` +
      `\ncarried on and said so. Each is capping what every run in that project can` +
      `\nverify, which is why they are ranked by how often they recur.`,
    )
    break
  }

  case 'monitor': {
    const { claimMonitorNotices, displayConditions, formatMonitorPass, markMonitorNoticesDelivered, monitor, monitorHistory } = await import('./monitor.ts')
    if (flag('ack-notices') !== undefined) {
      const sid = sessionId()
      if (!sid) throw new Error('monitor notice acknowledgement requires CLAUDE_CODE_SESSION_ID')
      if (!monitorDeliveryAuthorized()) throw new Error('monitor notice acknowledgement requires a live delivery-hook capability')
      const ids = flag('ack-notices')!.split(',') as import('./monitor.ts').MonitorNotice['noticeId'][]
      markMonitorNoticesDelivered(sid, ids)
      break
    }
    if (has('notices')) {
      const sid = sessionId()
      if (!sid) throw new Error('monitor notices require CLAUDE_CODE_SESSION_ID')
      const rows = claimMonitorNotices(sid)
      if (has('json')) await writeStdout(`${JSON.stringify(rows)}\n`)
      else for (const condition of rows) {
        console.log(`MONITOR ${condition.kind} ${condition.subject}: ${condition.detail}`)
      }
      break
    }
    if (has('history')) {
      const rows = monitorHistory(Number(flag('limit') ?? 20))
      if (has('json')) await writeStdout(`${JSON.stringify(rows)}\n`)
      else for (const row of rows as any[]) {
        console.log(formatMonitorPass(
          `monitor ${row.id}  ${row.started_at}  ${row.trigger}  ${row.findings} found, ${row.errors} errors`,
          displayConditions(row.conditions),
        ).join('\n'))
      }
      break
    }
    const result = await monitor(has('backstop') ? 'backstop' : 'invoked')
    if (has('json')) await writeStdout(`${JSON.stringify(result)}\n`)
    else {
      const { failingCanonEvalSlugs } = await import('./evals.ts')
      const failingEvals = failingCanonEvalSlugs()
      const lines = [`canon: ${result.canon.findings} stale references in ${result.canon.docs} docs`]
      if (failingEvals.length) {
        lines.push(`canon evals: ${failingEvals.length} failing (${failingEvals.join(', ')})`)
      }
      if (result.conditions.length || result.errors.length) {
        lines.push(...formatMonitorPass(
          `monitor ${result.id}: ${result.conditions.length} condition(s), ${result.errors.length} observation error(s)`,
          result.conditions,
        ))
        for (const error of result.errors) console.error(`  observation failed: ${error}`)
      }
      await writeStdout(`${lines.join('\n')}\n`)
    }
    // Branchable by hooks and automation: 0 clean, 2 conditions, 1 incomplete observation.
    if (result.errors.length) process.exitCode = 1
    else if (result.conditions.length) process.exitCode = 2
    break
  }

  case 'reclaim': {
    const { reclaimBranch, reclaimWorktree } = await import('./reclaim.ts')
    const kind = argv[1]
    const subject = argv[2]!
    const result = kind === 'worktree'
      ? reclaimWorktree(subject, { dryRun: has('dry-run') })
      : reclaimBranch(subject, { dryRun: has('dry-run') })
    if (!result.ok) throw new Error(result.action)
    console.log(result.action)
    break
  }

  case 'inbox': {
    const commandFlags = { has }
    const presentation = {
      log: console.log, dur, chainHasPendingDelivery, strandedRecovery,
    }
    await runInboxCommand(commandFlags, presentation)
    break
  }

  case 'answer': {
    await Promise.all([loadJobs(), loadAgents(), loadRoute(), loadRun(), loadWorktree(), loadContract()])
    const requestedId = Number(argv[1])
    if (!requestedId) usage()
    await answerRun(requestedId, { argv: argv.slice(2), recordOnly: has('record-only'), flags: {
      detach: has('detach'), follow: has('follow'), quiet: has('quiet'),
    } }, runAnswerHelpers)
    break
  }
  /**
   * Carry on a conversation that has no open question.
   *
   * `orch answer` is for a worker waiting on a ruling. This is for the other
   * two cases, and both are real:
   *
   *   - The chain was INTERRUPTED. A killed process group leaves a run `failed`
   *     with its questions already answered, and nothing could restart it —
   *     everything it had read was still sitting in a vendor session that no
   *     command could reach. The work was recoverable and unreachable at once,
   *     which is the worst combination.
   *   - The architect has something to ADD. A worker that finished is one short
   *     turn away from doing the next thing, with all its context intact, and
   *     re-running the spec to say "also update the tests" would pay for the
   *     whole survey again.
   *
   * Deliberately NOT a way to keep a worker going indefinitely: each call is a
   * turn the architect chose to spend, recorded like any other.
   */
  case 'continue': {
    await Promise.all([loadJobs(), loadAgents(), loadRun(), loadWorktree(), loadContract()])
    const id = Number(argv[1])
    if (!id) usage()
    const chain = db().query(
      'SELECT id, agent, parent_run_id FROM run WHERE id = ?',
    ).get(id) as { id: number; agent: string; parent_run_id: number | null } | null
    const sources = parseWorkerMessageArgs(argv.slice(2), {
      booleans: ['--follow', '--detach', '--quiet'],
      usage: 'orch continue <id> ["<what next>"] [--file PATH] [--follow]',
    })
    const message = await readMessageText({
      missing: 'no message: pass it as an argument, via --file, or on stdin',
      exclusive: 'pass the message either positionally or with --file, not both',
      optional: true,
      sources,
    })
    if (message !== undefined) {
      assertWorkerText(
        message, 'message', CONTINUE_WORKING_FORMS,
        chain ? argvResumeLimit(chain.agent) : undefined,
      )
    }
    const resumed = await continueRun(id, message)
    await reportContinuedRun(resumed.childId, resumed.job)
    break
  }

  case 'diff': {
    await Promise.all([loadJobs(), loadWorktree()])
    const id = Number(argv[1])
    const commandFlags = { has }
    const presentation = {
      error: console.error, write: (value: string) => { process.stdout.write(value) }, usage,
      cleanupRepoRoot,
      changesIn: worktreeModule.changesIn,
      writesRepo: (jobName: string) => Boolean(JOBS[jobName]?.needs.writesRepo),
    }
    await runDiffCommand(id, commandFlags, presentation)
    break
  }

  case 'sweep': {
    await loadGrokTrust()
    await sweepRuns({ dryRun: has('dry-run'), project: flag('project'), force: has('force'), presentation: cleanupPresentation }, { grokTrustHeadings, grokTrustPathFromHeading })
    break
  }
  case 'discard': {
    const id = Number(argv[1]); if (!id) usage()
    await discardRun(id, { force: has('force'), auditReason: auditReason(), presentation: cleanupPresentation })
    break
  }

  case 'close-out': {
    await loadRun()
    const id = Number(argv[1])
    if (!id) usage()
    writableDb()
    const result = closeOutRun(id, {
      intent: 'explicit', lockTimeoutMs: has('non-blocking') ? 0 : undefined,
    })
    console.log(`${result.outcome} run ${result.runId}${result.worktree ? ` ${result.worktree}` : ''}: ${result.detail}`)
    if (result.outcome === 'held' || result.outcome === 'failed') process.exitCode = 1
    break
  }

  case 'stop': {
    await loadRun()
    const id = Number(argv[1]); if (!id) usage()
    await stopRun(id, { force: has('force'), auditReason: auditReason(), presentation: cleanupPresentation }, { lifecycleCheckpoint, terminateRunProcesses })
    break
  }

  case 'abandon': {
    await loadRun()
    const id = Number(argv[1]); if (!id) usage()
    await abandonRun(id, { force: has('force'), note: flag('note'), auditReason: auditReason(), presentation: cleanupPresentation }, { lifecycleCheckpoint, terminateRunProcesses })
    break
  }

  case 'judge': {
    await Promise.all([loadJobs(), loadWorktree()])
    writableDb()
    const requestedId = Number(argv[1]); if (!requestedId) usage()
    const judgementFlags = { has, flag, values: flags }
    const words = argv.slice(2).filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv.slice(2)[i - 1] ?? ''))
    const options = { words, note: scoreNote(), auditReason: auditReason(), notEvidence: NOT_EVIDENCE }
    const result = judgeRun(requestedId, judgementFlags, options, judgementPresentation)
    // The CLI adapter deliberately composes judgement then cleanup for judge --discard.
    if (has('discard')) {
      if (!result.row.worktree) throw new Error(`run ${result.id} has no worktree to discard`)
      const discardAuthority = authorizeRunMutation(result.id, 'discard')
      discardWorktree(result.row as CleanupRow, 'discarded', false, discardAuthority, { force: false, auditReason: auditReason(), presentation: cleanupPresentation })
    }
    break
  }

  case 'score': {
    await Promise.all([loadJobs(), loadAgents(), loadRoute()])
    writableDb()
    const requestedId = Number(argv[1]); if (!requestedId) usage()
    const words = argv.slice(2).filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv.slice(2)[i - 1] ?? ''))
    scoreRun(requestedId, { has, flag, values: flags }, { words, note: scoreNote(), auditReason: auditReason(), dashboardAuthorized: dashboardScoreAuthorized(flag('scorer')), notEvidence: NOT_EVIDENCE }, judgementPresentation)
    break
  }

  case 'recalibrate': {
    await Promise.all([loadJobs(), loadAgreement()])
    await recalibrate({ has, flag }, { log: (...values) => console.log(...values), write: (value) => process.stdout.write(value), input: process.stdin, output: process.stdout })
    break
  }
  case 'routing-backtest': {
    await Promise.all([loadJobs(), loadAgents(), loadRoutingBacktest()])
    const jobFilter = flag('job')
    const seedFlag = flag('seed')
    const seed = seedFlag === undefined ? undefined : Number(seedFlag)
    if (seedFlag !== undefined && (!/^\d+$/.test(seedFlag) || !Number.isSafeInteger(seed))) {
      throw new Error('--seed must be a non-negative integer')
    }
    const assumptions = {
      outcomeComparison: 'not identifiable: agreements have the same logged outcome, while disagreements have no counterfactual outcome for the agent not run',
      policyLearning: 'each simulated policy updates only from logged runs where it chose the historical agent',
      latency: 'a matched successful run enters tie-break latency at chain completion whether or not it was scored',
      eligibility: 'current static capability, metered, prompt-size and context rules',
      cooldowns: 'reconstructed from the full terminal operational stream, including quota/auth failures and successful probes; these events do not become scoring evidence',
      reachability: 'present-day reachability ignored',
      evidence: 'every non-probe root dispatch is a decision; default distributions omit voided/evidence-excluded rows, while NOT_EVIDENCE runs remain decisions but never enter policy evidence',
      causalAvailability: 'scored evidence enters at scored_at; eligible unjudged failures enter at the terminating chain member time; dispatch sees only earlier available evidence',
      ties: 'inside the noise band Thompson ties use reviewer precision when available, then unmetered and median latency',
      betaMapping: 'successes += (w + 0.5) / 1.5; failures += 1 - successes',
      exploration: 'choice differs from deterministic expected leader',
      scope: jobFilter ? `only job ${jobFilter}` : 'all displayed jobs',
    }
    const distribution = (values: Record<string, number>) => Object.entries(values)
      .sort(([a], [b]) => a.localeCompare(b)).map(([agent, count]) => `${agent}=${count}`).join(', ') || 'none'
    const movedSelections = (baseline: RoutingBacktest, comparison: RoutingBacktest) => {
      const moved = (key: 'currentSelections' | 'thompsonSelections') => baseline.jobs.reduce((total, row) => {
        const other = comparison.jobs.find((candidate) => candidate.job === row.job)
        const agents = new Set([...Object.keys(row[key]), ...Object.keys(other?.[key] ?? {})])
        return total + [...agents].reduce(
          (sum, agent) => sum + Math.abs((row[key][agent] ?? 0) - (other?.[key][agent] ?? 0)), 0,
        ) / 2
      }, 0)
      return { current: moved('currentSelections'), thompson: moved('thompsonSelections') }
    }
    const printTrajectory = (result: RoutingBacktest, voided: RoutingBacktest, indent = '') => {
      console.log(`${indent}seed ${result.seed}: causal exclusions ${result.causalExcludedJudgements}; unscored decisions ${result.unscoredDecisions}`)
      const jobs = [...new Set([...result.jobs, ...voided.jobs].map((row) => row.job))]
      for (const job of jobs) {
        const row = result.jobs.find((candidate) => candidate.job === job)
        const included = voided.jobs.find((candidate) => candidate.job === job)
        console.log(
          `${indent}  ${job}: runs=${row?.runs ?? 0} agreements=${row?.agreements ?? 0} ` +
          `agreement=${((row?.agreementShare ?? 0) * 100).toFixed(1)}% ` +
          `Thompson-exploration=${((row?.thompsonExplorationShare ?? 0) * 100).toFixed(1)}% ` +
          `voided-excluded live-Thompson=[${distribution(row?.currentSelections ?? {})}] comparison-Thompson=[${distribution(row?.thompsonSelections ?? {})}]; ` +
          `voided-included live-Thompson=[${distribution(included?.currentSelections ?? {})}] ` +
          `Thompson=[${distribution(included?.thompsonSelections ?? {})}]`,
        )
      }
    }
    if (seed !== undefined) {
      const result = routingBacktest(jobFilter, seed)
      const voidedIncluded = routingBacktest(jobFilter, seed, { includeVoided: true })
      const cooldownDisabled = routingBacktest(jobFilter, seed, { cooldowns: false })
      const cooldownMoves = movedSelections(result, cooldownDisabled)
      const outputAssumptions = {
        ...assumptions,
        causalExclusions: `${result.causalExcludedJudgements} earlier judgement/dispatch pairs excluded`,
        unscoredDecisions: `${result.unscoredDecisions} dispatches have no score and contribute no quality evidence`,
        cooldownSensitivity: `disabling cooldown redistributes ${cooldownMoves.current} current-policy and ${cooldownMoves.thompson} Thompson selections`,
      }
      if (has('json')) {
        console.log(JSON.stringify({
          mode: 'single-seed-reproduction', assumptions: outputAssumptions, ...result,
          sensitivities: { voidedIncluded, cooldownDisabled: { selectionMoves: cooldownMoves } },
        }))
        break
      }
      console.log(`routing replay diagnostic (seed ${seed}; descriptive only)`)
      console.log('assumptions:')
      for (const [key, value] of Object.entries(outputAssumptions)) console.log(`  ${key}: ${value}`)
      printTrajectory(result, voidedIncluded)
      break
    }
    const result = routingBacktestEnsemble(jobFilter)
    const voidedIncluded = routingBacktestEnsemble(jobFilter, { includeVoided: true })
    const cooldownDisabled = routingBacktestEnsemble(jobFilter, { cooldowns: false })
    const cooldownMoves = movedSelections(
      { seed: 0, causalExcludedJudgements: 0, unscoredDecisions: 0, jobs: result.jobs },
      { seed: 0, causalExcludedJudgements: 0, unscoredDecisions: 0, jobs: cooldownDisabled.jobs },
    )
    const causalExcludedJudgements = result.trajectories[0]?.causalExcludedJudgements ?? 0
    const unscoredDecisions = result.trajectories[0]?.unscoredDecisions ?? 0
    const outputAssumptions = {
      ...assumptions,
      causalExclusions: `${causalExcludedJudgements} earlier judgement/dispatch pairs excluded per trajectory`,
      unscoredDecisions: `${unscoredDecisions} dispatches have no score and contribute no quality evidence`,
      cooldownSensitivity: `disabling cooldown redistributes ${cooldownMoves.current} current-policy and ${cooldownMoves.thompson} Thompson selections across all seeds`,
    }
    if (has('json')) {
      console.log(JSON.stringify({
        mode: 'ensemble', assumptions: outputAssumptions, ...result,
        sensitivities: { voidedIncluded, cooldownDisabled: { selectionMoves: cooldownMoves } },
      }))
      break
    }
    console.log(`routing replay diagnostic (seeds ${result.seeds.join(', ')}; descriptive only)`)
    console.log('assumptions:')
    for (const [key, value] of Object.entries(outputAssumptions)) console.log(`  ${key}: ${value}`)
    console.log('aggregate across seeds:')
    const jobs = [...new Set([...result.jobs, ...voidedIncluded.jobs].map((row) => row.job))]
    for (const job of jobs) {
      const row = result.jobs.find((candidate) => candidate.job === job)
      const included = voidedIncluded.jobs.find((candidate) => candidate.job === job)
      console.log(
        `  ${job}: decisions=${row?.runs ?? 0} agreements=${row?.agreements ?? 0} ` +
        `agreement=${((row?.agreementShare ?? 0) * 100).toFixed(1)}% ` +
        `Thompson-exploration=${((row?.thompsonExplorationShare ?? 0) * 100).toFixed(1)}% ` +
        `voided-excluded live-Thompson=[${distribution(row?.currentSelections ?? {})}] comparison-Thompson=[${distribution(row?.thompsonSelections ?? {})}]; ` +
        `voided-included live-Thompson=[${distribution(included?.currentSelections ?? {})}] ` +
        `Thompson=[${distribution(included?.thompsonSelections ?? {})}]`,
      )
    }
    break
  }

  case 'runs': {
    await loadJobs()
    const options = { jsonV1: argv.includes('--json=v1') }
    const commandFlags = { has, flag, values: flags }
    const presentation = {
      log: console.log, dur, chainIsStranded, strandedRecovery, thinOutputWarning,
    }
    await runListingCommand(options, commandFlags, presentation)
    break
  }

  case 'guide': {
    await Promise.all([loadJobs(), loadAgents(), loadRoute(), loadGuide()])
    await ensureLocalHealth()
    const rawPromptBytes = flag('prompt-bytes')
    const promptBytes = rawPromptBytes === undefined ? undefined : Number(rawPromptBytes)
    if (promptBytes !== undefined &&
        (!/^\d+$/.test(rawPromptBytes!) || !Number.isSafeInteger(promptBytes))) {
      throw new Error('--prompt-bytes must be a non-negative integer')
    }
    const gs = guide(flag('job'), promptBytes, flag('lens'))
    if (flag('lens')) {
      const { resolveLens }=await import('./lenses.ts'); const p=projectAt(process.cwd())
      const resolved=resolveLens(flag('lens')!,p?.name??null)
      console.log(`lens profiles: ${resolved ? resolved.profiles.map(x=>`${x.axis}=${x.name}@${x.version}`).join(', ') : 'free-form (no catalogue row)'}`)
    }
    const size = (b: number) => (b >= 1024 ? `${Math.round(b / 1024)}KB` : `${Math.round(b)}B`)
    const tradeoffs: string[] = []
    let decided = 0, provisional = 0, blank = 0

    for (const g of gs) {
      const bucket = g.promptBucket === null
        ? ''
        : ` [${promptSizeBucketLabel(g.promptBucket)} prompts]`
      console.log(`\n${g.job}${bucket}  ${g.what}`)
      if (!g.tried.length) {
        blank++
        console.log('  no runs yet - nothing to compare')
      } else {
        if (g.decided) decided++
        else if (g.best) provisional++
        if (g.best) {
          const rawBest = [...g.tried]
            .filter((candidate) => candidate.score !== null)
            .sort((a, b) => b.score! - a.score! || b.evidence - a.evidence)[0]
          console.log(
            `  best     ${g.best.agent.padEnd(11)} ${((g.best.score! * 100).toFixed(0) + '%').padStart(5)}` +
            ` raw, ${((g.best.shrunk! * 100).toFixed(0) + '%').padStart(5)} shrunk` +
            // "judged", not "scored": the percentage now includes failed runs
            // at the `unusable` weight, so labelling it with the verdict count
            // alone described a smaller denominator than the number came from.
            `  over ${g.best.evidence} judged` +
            (g.best.failures ? ` (incl. ${g.best.failures} failed)` : '') +
            (rawBest && rawBest.agent !== g.best.agent ? `   SHRUNK LEADER (raw: ${rawBest.agent})` : '') +
            (g.decided ? '' : `   PROVISIONAL - needs ${MIN_SAMPLE}`),
          )
        } else console.log('  best     - nothing scored yet')

        // With one agent tried there is no quickest, only a measurement.
        const q = g.quickest ?? g.tried[0]!
        const solo = !g.quickest
        console.log(
          `  ${solo ? 'speed   ' : 'quickest'} ${q.agent.padEnd(11)} ${dur(q.latencyMs).padStart(5)}` +
          `  median over ${q.runs} run${q.runs === 1 ? '' : 's'}, ~${size(q.promptBytes)} prompts` +
          (solo ? '   (only agent tried)' : ''),
        )
        if (g.best && g.quickest && g.best.agent !== g.quickest.agent) {
          tradeoffs.push(
            `${g.job}${bucket}: ${g.best.agent} judges best, ${g.quickest.agent} is ` +
            `${dur(g.quickest.latencyMs)} vs ${dur(g.best.latencyMs)}`,
          )
        }
      }
      if (g.untried.length) console.log(`  untried  ${g.untried.join(', ')}`)
      for (const e of g.excluded) console.log(`  excluded ${e.agent}: ${e.why}`)
      for (const cell of g.evidenceCells) {
        console.log(
          `  evidence ${cell.name}: ` +
          (cell.counts.length
            ? cell.counts.map((row) => `${row.agent}=${row.evidence}`).join(', ')
            : 'no judgements'),
        )
      }
      console.log(`  routes to ${g.routesTo}   (${g.reason})`)
    }

    if (tradeoffs.length) {
      console.log('\n  Best and quickest disagree - pick on what the job needs:')
      for (const t of tradeoffs) console.log(`    ${t}`)
    }
    console.log(
      `\n  ${decided} bucket(s) decided by evidence, ${provisional} provisional, ${blank} with no runs.` +
      `\n  Routing and latency evidence are separated at the provisional 16 KiB prompt boundary.`,
    )
    break
  }

  case 'spawns': {
    // What the subagent gate actually did. Denials are work that should have
    // gone to an external agent; allows are the irreducible remainder, and the
    // split between "declared" and everything else is the number to watch.
    const rows = db().query(
      `SELECT decision, why, COUNT(*) n FROM spawn
        GROUP BY decision, why ORDER BY n DESC`,
    ).all() as { decision: string; why: string; n: number }[]
    if (!rows.length) { console.log('no spawns recorded yet'); break }
    const total = rows.reduce((a, r) => a + r.n, 0)
    console.log(`\n  ${total} subagent spawn(s) seen by the gate\n`)
    for (const r of rows) {
      console.log(
        `  ${r.decision.padEnd(8)} ${r.why.padEnd(14)} ${String(r.n).padStart(4)}` +
        `  ${((r.n / total) * 100).toFixed(0)}%`,
      )
    }
    const recent = db().query(
      `SELECT at, decision, why, subagent_type, description FROM spawn
        ORDER BY id DESC LIMIT ?`,
    ).all(Number(flag('limit') ?? 15)) as Record<string, string>[]
    console.log('\n  when                 decision  why             what')
    for (const r of recent) {
      console.log(
        `  ${String(r.at).replace('T', ' ').slice(0, 19)}  ${String(r.decision).padEnd(8)}` +
        `  ${String(r.why).padEnd(14)}  ${String(r.description ?? '').slice(0, 46)}`,
      )
    }
    console.log(
      '\n  A denial is work an external agent could have done. A rising share of' +
      '\n  "declared-web" that is not really web work is the thing to watch for.',
    )
    break
  }

  case 'stats': {
    await Promise.all([loadJobs(), loadRoute(), loadAgreement()])
    // scoreboard(), not a query of its own. The comment that used to sit here
    // claimed exactly that and had stopped being true: this filtered
    // status='ok' after the router stopped, so grok on review-lens read 96%
    // here and 69% to the thing actually choosing an agent. A report that
    // disagrees with the decision it describes is worse than no report.
    const rows = scoreboard(flag('job'))
      .sort((a, b) => a.job.localeCompare(b.job) || (b.shrunk ?? -9) - (a.shrunk ?? -9))
    const matrices = duelMatrices(flag('job'))
    if (!rows.length && !matrices.length) { console.log('no runs yet'); break }
    if (rows.length) {
      console.log('job / prompt bucket            agent        runs  judged    raw  shrunk  median    vendor tokens      cost')
      for (const r of rows) {
        const score = r.score === null ? '—' : `${(r.score * 100).toFixed(0)}%`
        const shrunk = r.shrunk === null ? '—' : `${(r.shrunk * 100).toFixed(0)}%`
        const cost = r.costUsd > 0 ? `$${r.costUsd.toFixed(4)}` : '—'
        // Failures are part of the score, so they are shown beside it rather than
        // left for someone to wonder why the percentage looks low.
        const judged = r.failures ? `${r.evidence}(${r.failures}f)` : String(r.evidence)
        console.log(
          `${`${r.job} [${promptSizeBucketLabel(r.promptBucket)}]`.padEnd(30)} ` +
            `${r.agent.padEnd(11)} ${String(r.runs).padStart(5)} ${judged.padStart(7)}` +
            ` ${score.padStart(6)} ${shrunk.padStart(7)} ${dur(r.latencyMs).padStart(8)} ${r.tokens.toLocaleString().padStart(17)}` +
            ` ${cost.padStart(9)}`,
        )
      }
    }
    for (const matrix of matrices) {
      const duelCount = matrix.agents.reduce((sum, agent) => sum +
        matrix.agents.reduce((agentSum, opponent) => agentSum + matrix.cells[agent]![opponent]!.wins, 0), 0)
      if (duelCount >= MIN_SAMPLE) {
        const strengths = bradleyTerry(
          matrix.agents,
          (winner, loser) => matrix.cells[winner]![loser]!.wins,
        )
        console.log(`\n${matrix.job} Bradley-Terry strengths (${duelCount} duels)`)
        console.log('agent        strength')
        for (const row of strengths) {
          console.log(`${row.agent.padEnd(12)} ${row.strength.toFixed(3).padStart(8)}`)
        }
        continue
      }
      const width = Math.max(7, ...matrix.agents.map((agent) => agent.length))
      console.log(`\n${matrix.job} duels (wins-losses)`)
      console.log(`${'agent'.padEnd(width)} ${matrix.agents.map((a) => a.padStart(width)).join(' ')}`)
      for (const agent of matrix.agents) {
        const cells = matrix.agents.map((opponent) => {
          if (opponent === agent) return '-'.padStart(width)
          const cell = matrix.cells[agent]![opponent]!
          return `${cell.wins}-${cell.losses}`.padStart(width)
        }).join(' ')
        console.log(`${agent.padEnd(width)} ${cells}`)
      }
    }
    break
  }

  case 'pick': {
    await Promise.all([loadJobs(), loadAgents(), loadRoute(), loadRun(), loadWorktree(), loadTransport()])
    await ensureLocalHealth()
    // --stack, or the stack of wherever you are standing. A route is a claim
    // about a job IN A CONTEXT, and reporting it without the context invites
    // reading a php verdict as a node one.
    const jobName = argv[1]
    if (!jobName) usage()
    if (job(jobName).needs.readsRepo) warnCallerDrift(process.cwd())
    const { stackAt } = await import('./projects.ts')
    const { evidenceFor } = await import('./route.ts')
    const stack = flag('stack') ?? stackAt(process.cwd())
    const { avoid, distinctModels } = await routeConstraints(flag('agent'))
    // explore=false: a report that spent the exploration coin would name a
    // different agent each time it was read.
    const lens = flag('lens')
    const transport = resolveTransportName(flag('transport'))
    if (transport === 'acp') assertAcpAllowed(jobName, flag('agent'))
    const p = pick(jobName, selectAgentForTransport(transport, flag('agent')), 0, false, stack,
      { agents: avoid, models: distinctModels }, false, lens)
    const ev = evidenceFor(jobName, 0, stack, undefined, lens)
    if (lens) {
      const { resolveLens }=await import('./lenses.ts'); const resolved=resolveLens(lens,projectAt(process.cwd())?.name??null)
      console.log(`selected profiles: ${resolved ? resolved.profiles.map(x=>`${x.axis}=${x.name}@${x.version}`).join(', ') : 'free-form (no catalogue row)'}`)
    }
    const counts = (rows: typeof ev.cands) => rows
      .filter((candidate) => candidate.evidence > 0)
      .map((candidate) => `${candidate.agent}=${candidate.evidence}`)
      .join(', ') || 'no judgements'
    console.log(
      `${jobName} -> ${p.agent}   (${p.reason})\n` +
      `  deciding cell: ${ev.level === 'lens' ? `lens ${ev.lens}` : ev.level === 'stack' ? `stack ${ev.stack}` : 'job-wide'}\n` +
      (ev.scoped && ev.lens
        ? `  lens ${ev.lens} evidence: ${counts(ev.scoped)}\n  job-wide evidence: ${counts(ev.job)}\n`
        : `  evidence: ${ev.level === 'stack' ? `${ev.stack} only` : 'all stacks'}` +
          `${stack && ev.level === 'job' ? ` (too little on ${stack} to compare agents there)` : ''}\n`),
    )
    const listed = [...ev.cands].sort((a, b) => {
      const rank = (candidate: typeof a) =>
        AGENTS[candidate.agent]?.billing === 'local' && candidate.preferred ? 0 : 1
      return rank(a) - rank(b)
    })
    for (const c of listed) {
      const probe = AGENTS[c.agent]?.probeResult as { mcp?: { verifiable?: boolean } } | null
      const mcpNote = probe?.mcp && probe.mcp.verifiable === false ? ' mcp: unverifiable' : ''
      console.log(
        `  ${c.agent.padEnd(7)} ${c.eligible ? 'eligible' : 'excluded'.padEnd(8)}` +
          ` declared=${c.declared?.join(',') ?? 'any'} preferred=${c.preferred ? 'yes' : 'no'}` +
          ` runs=${String(c.runs).padStart(3)} judged=${String(c.evidence).padStart(3)}` +
          ` score=${c.score === null ? "—" : (c.score * 100).toFixed(0) + "%"}` +
          ` shrunk=${c.shrunk === null ? "—" : (c.shrunk * 100).toFixed(0) + "%"}  ${c.why}${mcpNote}`,
      )
    }
    console.log(`\n  (a rate steers routing only at ${MIN_SAMPLE}+ scored runs)`)
    break
  }

  case 'pending': {
    await loadJobs()
    // Runs THIS session made that it has not judged. Exits 1 when any remain,
    // so a hook or a script can act on it.
    const rows = pendingForSession(sessionId())
    const pairs = unrecordedPairsForSession(sessionId())
    if (!rows.length && !pairs.length) { console.log('nothing of yours is unscored or awaiting comparison'); break }
    if (rows.length) {
      console.log(`${rows.length} run${rows.length === 1 ? '' : 's'} you made are unscored:\n`)
      for (const r of rows) {
        console.log(
          `  orch score ${r.id} <none|partial|full> [wrong|mixed|right]   # ${r.agent}/${r.job}  ${r.prompt_head.slice(0, 40)}` +
          (r.rescore ? '  rescore' : ''),
        )
      }
    }
    if (pairs.length) {
      console.log(`${rows.length ? '\n' : ''}${pairs.length} scored pair${pairs.length === 1 ? '' : 's'} await comparison:\n`)
      for (const pair of pairs) {
        console.log(`  run ${pair.runId}`)
        console.log(`    ${pairHint({ id: pair.partnerId, agent: pair.partnerAgent })}`)
      }
    }
    console.log('\nOnly you know whether these answers were useful. An unscored run')
    console.log('teaches the router nothing, and a guessed score teaches it something false.')
    process.exitCode = 1
    break
  }

  case 'metric': {
    const { collect, summary } = await import('./metric.ts')
    if (argv[1] === 'collect') {
      const t0 = Date.now()
      const n = await collect(Number(flag('days') ?? 30))
      console.log(`collected ${n} day(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    }
    const s = summary(Number(flag('window') ?? 14))
    if (!s.days) { console.log('no metric data — run: orch metric collect'); break }
    console.log(`\nClaude tokens per shipped task — last ${s.days} day(s) with data\n`)
    console.log(`  canon tokens  ${s.canonTokens.toLocaleString()}`)
    console.log(`  total tokens  ${s.tokens.toLocaleString()}`)
    console.log(`  untracked     ${s.otherTokens.toLocaleString()}`)
    console.log(`  tasks shipped ${s.tasks}`)
    console.log(`  PER TASK      ${s.perTask ? s.perTask.toLocaleString() : '—'}`)
    console.log(`  per message   ${s.perMessage ? s.perMessage.toLocaleString() : '—'}   (average context carried per turn)`)
    const arrow = { improving: 'DOWN', worsening: 'UP', flat: 'FLAT', unknown: '—' }[s.direction]
    const pct = s.changePct === null ? '' : ` ${Math.abs(s.changePct).toFixed(0)}%`
    console.log(`  TREND         ${arrow}${pct}  ${
      s.direction === 'unknown' ? '(too few tasks in a half to say)'
      : `(${s.earlier.perTask?.toLocaleString()} -> ${s.recent.perTask?.toLocaleString()} per task, halves of the window)`}`)
    if (s.excluded) console.log(`                excluding ${s.excluded} day(s): today is incomplete, and a day with tasks but no tokens is a gap`)

    const mg = (v: number) => v >= 1e9 ? (v / 1e9).toFixed(1) + 'B'
      : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(v)
    console.log('\n  LENSES — canon spend over four denominators, none of them trustworthy alone\n')
    for (const l of s.lenses) {
      console.log(`  ${l.label.padEnd(18)}${String(l.denom).padStart(9)}  ->  ${(l.perUnit ? mg(l.perUnit) : '—').padStart(8)}`)
      console.log(`  ${''.padEnd(18)}${l.caveat}`)
    }
    const mixTotal = s.mix.reduce((a, x) => a + x.lines, 0)
    if (mixTotal > 0) {
      console.log('\n  lines changed by kind:')
      for (const x of s.mix) {
        console.log(`    ${x.kind.padEnd(11)}${x.lines.toLocaleString().padStart(11)}  ${((x.lines / mixTotal) * 100).toFixed(1).padStart(5)}%`)
      }
    }
    if (s.untrackedShare > 0.02) {
      console.log(`\n  ${(s.untrackedShare * 100).toFixed(1)}% of spend was outside the canon repos — work with no denominator here.`)
    }
    console.log('\n  day          tokens        tasks   per task')
    for (const r of s.series.slice(-10)) {
      const pt = r.tasks ? Math.round(r.canon_tokens / r.tasks).toLocaleString() : '—'
      const flag = r.partial ? '  <- today, incomplete' : r.gap ? '  <- no tokens recorded' : ''
      console.log(`  ${r.day}  ${r.claude_tokens.toLocaleString().padStart(13)}  ${String(r.tasks).padStart(6)}  ${pt.padStart(10)}${flag}`)
    }
    break
  }

  case 'serve':
    // The dashboard moved to hub, which shows this concern's routing and runs
    // beside the work they were spent on - the thing neither page could do
    // alone. Kept as a signpost rather than deleted, because muscle memory
    // outlives a rename.
    console.error('the dashboard moved: run `hub serve` (http://127.0.0.1:7778)')
    process.exit(1)

  /**
   * Re-run only the DEV-122 quota/auth signatures over old, unclassified
   * failures. This is deliberately not a general reclassification: a stored
   * failure is evidence, and changing its meaning on anything less than that
   * row's own vendor error would rewrite the agent's record.
   */
  case 'reclassify-failures': {
    await loadJobs()
    type FailureRow = {
      id: number; agent: string; job: string; status: string
      failure_kind: string | null; error: string
    }
    type CountRow = { agent: string; failure_kind: string | null; count: number }

    const all = db().query(
      `SELECT id, agent, job, status, failure_kind, error
         FROM run
        WHERE status IN ('failed', 'stale')
        ORDER BY id`,
    ).all() as FailureRow[]
    const matched = all.flatMap((row) => {
      if ((row.failure_kind !== 'other' && row.failure_kind !== null) || !row.error) return []
      const kind = classify(row.error)
      return kind === 'quota' || kind === 'auth' ? [{ row, kind }] : []
    })

    const counts = (rows: { agent: string; failure_kind: string | null }[]): CountRow[] => {
      const grouped = new Map<string, CountRow>()
      for (const row of rows) {
        const key = JSON.stringify([row.agent, row.failure_kind])
        const existing = grouped.get(key)
        if (existing) existing.count++
        else grouped.set(key, { agent: row.agent, failure_kind: row.failure_kind, count: 1 })
      }
      return [...grouped.values()].sort((a, b) =>
        a.agent.localeCompare(b.agent) || (a.failure_kind ?? '').localeCompare(b.failure_kind ?? ''))
    }
    const printCounts = (label: string, rows: CountRow[]) => {
      console.log(`${label} (all failed/stale rows)`)
      if (!rows.length) console.log('  (none)')
      for (const row of rows) {
        console.log(`  ${row.agent}  ${row.failure_kind ?? 'null'}  ${row.count}`)
      }
    }

    const before = counts(all)
    const replacement = new Map(matched.map(({ row, kind }) => [row.id, kind]))
    const projected = counts(all.map((row) => ({
      agent: row.agent,
      failure_kind: replacement.get(row.id) ?? row.failure_kind,
    })))

    printCounts('BEFORE', before)
    console.log(`\nPLAN (${matched.length} matched row${matched.length === 1 ? '' : 's'})`)
    for (const { row, kind } of matched) {
      console.log(`run ${row.id}  ${row.agent}/${row.job}  [${row.status}]  ${row.failure_kind ?? 'null'} -> ${kind}`)
      console.log(row.error)
    }
    console.log('')
    printCounts('AFTER', projected)

    if (has('dry-run')) {
      console.log(`\n${matched.length} row${matched.length === 1 ? '' : 's'} would be reclassified — dry run, no writes.`)
      break
    }

    writableDb()

    const update = db().query(
      `UPDATE run SET failure_kind = ?
        WHERE id = ? AND status IN ('failed', 'stale')
          AND (failure_kind = 'other' OR failure_kind IS NULL) AND error = ?`,
    )
    const apply = writeTransaction(() => {
      let changed = 0
      for (const { row, kind } of matched) {
        const result = update.run(kind, row.id, row.error)
        changed += result.changes
        if (result.changes) {
          auditRunMutation(
            runMutationActor(row.id), 'reclassify',
            `${row.failure_kind ?? 'null'} -> ${kind}`,
          )
        }
      }
      return changed
    })
    const changed = apply
    console.log(`\n${changed} row${changed === 1 ? '' : 's'} reclassified.`)
    break
  }

  case 'health': {
    const { harnessHealth } = await import('./health.ts')
    const { AttributionKindSchema } = await import('../../shared/orch-contract.ts')
    const report = harnessHealth(flag('days') ? Number(flag('days')) : undefined)
    if (has('json')) {
      console.log(JSON.stringify(report))
      break
    }
    const duration = (ms: number) => ms < 60_000
      ? `${(ms / 1000).toFixed(1)}s`
      : ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 3_600_000).toFixed(1)}h`
    console.log(report.header)
    console.log(`window: ${report.days} days from ${report.from}`)
    console.log('\nFAILURE CLASS'.padEnd(25) + 'COUNT'.padStart(7) + 'TOTAL'.padStart(10) +
      'MEAN'.padStart(10) + 'PRESERVED'.padStart(11) + '  FIRST SEEN'.padEnd(27) + 'LAST SEEN')
    for (const row of report.classes) {
      console.log(row.kind.padEnd(25) + String(row.count).padStart(7) +
        duration(row.totalTimeMs).padStart(10) + duration(row.meanTimeMs).padStart(10) +
        String(row.workPreserved).padStart(11) + '  ' +
        (row.firstSeen ?? '-').padEnd(25) + (row.lastSeen ?? '-') +
        (row.kind === 'idle' && row.reclaimedMs
          ? `  reclaimed ${duration(row.reclaimedMs)}`
          : ''))
      for (const cluster of row.clusters) {
        console.log(`  ${cluster.count}x [run ${cluster.exampleRunId}] ${cluster.text}`)
      }
      if (row.kind === 'escaped' && row.attribution) {
        console.log(
          '  attribution  ' + AttributionKindSchema.options
            .map((kind) => `${kind}=${row.attribution![kind]}`)
            .join(' '),
        )
      }
    }
    console.log('\nFALSE HARNESS VERDICTS')
    console.log('KIND'.padEnd(25) + 'FALSE'.padStart(7) + 'TOTAL'.padStart(7) + 'RATE'.padStart(9))
    for (const row of report.falseVerdicts.filter((row) => row.verdicts || row.falseVerdicts)) {
      console.log(row.kind.padEnd(25) + String(row.falseVerdicts).padStart(7) +
        String(row.verdicts).padStart(7) + `${(row.rate * 100).toFixed(1)}%`.padStart(9))
    }
    console.log(`landing refused`.padEnd(25) + String(report.landingRefusals).padStart(7) +
      '      -        -')
    console.log(`mcp probe failures`.padEnd(25) + String(report.mcpProbeFailures).padStart(7) +
      '      -        -')
    console.log(`mcp unprobed`.padEnd(25) + String(report.mcpUnprobed).padStart(7) +
      '      -        -')
    for (const row of report.mcpUnverifiedByAgent ?? []) {
      console.log(`mcp unverified ${row.agent}`.padEnd(25) + String(row.count).padStart(7) +
        '      -        -')
    }
    const { landingsWithPostStepError } = await import('./health.ts')
    for (const row of landingsWithPostStepError()) {
      console.log(`landed with post-step error`.padEnd(25) + `${row.project} ${row.branch}`)
      console.log(`  ${row.error}`)
    }
    console.log('\nCONTENTION (never routing evidence)')
    console.log('KIND'.padEnd(25) + 'COUNT'.padStart(7) + 'TOTAL'.padStart(10) +
      'MEAN'.padStart(10) + '  TOP KEYS')
    for (const row of report.contention.resources) {
      const keys = row.topKeys.length
        ? row.topKeys.map((key) => `${key.key} (${key.count})`).join(', ')
        : '-'
      console.log(row.kind.padEnd(25) + String(row.count).padStart(7) +
        duration(row.totalDurationMs).padStart(10) + duration(row.meanDurationMs).padStart(10) +
        '  ' + keys)
    }
    console.log('SESSION'.padEnd(25) + 'WAITS'.padStart(7) + 'INVALIDATIONS CAUSED'.padStart(22))
    for (const row of report.contention.sessions) {
      console.log(row.sessionId.padEnd(25) + String(row.waitsSuffered).padStart(7) +
        String(row.invalidationsCaused).padStart(22))
    }
    if (!report.contention.sessions.length) console.log('(none)')
    console.log('\nFLAKES')
    console.log('TEST'.padEnd(36) + 'FILE'.padEnd(36) + 'COUNT'.padStart(7) + '  LOAD')
    if (!report.flakes?.length) console.log('(none)')
    for (const row of report.flakes ?? []) {
      const load = row.loadAtFailure
      console.log(
        row.test.slice(0, 35).padEnd(36)
        + row.file.slice(0, 35).padEnd(36)
        + String(row.count).padStart(7)
        + `  gates=${load.gates} loadavg=${load.loadavg} ncpu=${load.ncpu} mem=${load.freeMem}`
        + ` signal=${row.signal ?? '-'}`,
      )
    }
    break
  }

  case 'epic': {
    const { epicChildren, epicScoreboard, renderEpicHuman } = await import('./epic.ts')
    const epicKey = argv[1]
    if (!epicKey) throw new Error('orch epic <TASK-KEY> [--json]')
    const report = epicScoreboard(epicKey, await epicChildren(epicKey))
    console.log(has('json') ? JSON.stringify(report) : renderEpicHuman(report))
    break
  }

  case 'doctor': {
    await Promise.all([loadJobs(), loadAgents(), loadRoute()])
    // Doctor composes transport health into machine diagnosis at the CLI adapter.
    const { acpRuntimeGaps } = await import('./transport.ts')
    const commandFlags = { has }
    const presentation = {
      log: console.log, exitCode: (code: number) => { process.exitCode = code },
      candidates, pick, jobs: () => Object.keys(JOBS), acpRuntimeGaps,
    }
    await doctorCommand(commandFlags, presentation)
    break
  }

  case 'jobs':
    await loadJobs()
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(Object.values(JOBS).map((job) => ({
        name: job.name,
        what: job.what,
        needs: job.needs,
        prefer: job.prefer,
        contextTokens: job.contextTokens,
        timeoutMs: job.timeoutMs ?? null,
        timeoutCeilingMs: job.timeoutCeilingMs ?? null,
        findings: Boolean(job.findings),
      }))))
      break
    }
    for (const j of Object.values(JOBS)) {
      const needs = Object.keys(j.needs).length ? ` [needs ${Object.keys(j.needs).join(',')}]` : ''
      // Fidelity judges adherence to a supplied implementation spec, so it is
      // visible here only on jobs that can change the repository.
      const axes = j.needs.writesRepo ? ' [axes delivery,quality,fidelity]' : ' [axes delivery,quality]'
      console.log(`${j.name.padEnd(15)} ${j.what}${needs}${axes}`)
    }
    break

  case 'agent': {
    await loadAgents()
    const sub = argv[1]
    const name = argv[2]
    const mutation = () => {
      const enabled = flag('enabled')
      if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') {
        throw new Error('--enabled must be true or false')
      }
      const context = flag('context-tokens')
      const jobs = flag('jobs')
      const prefer = flag('prefer')
      const maxConcurrent = flag('max-concurrent')
      const parseJobs = (value: string | undefined) => value === undefined ? undefined
        : value === 'any' ? null : value.split(',').map((job) => job.trim())
      return {
        ...(flag('harness') ? { harness: flag('harness') as any } : {}),
        ...(flag('backend') ? { backend: flag('backend') as any } : {}),
        ...(flag('model') ? { model: flag('model')! } : {}),
        ...(flag('base-url') ? { baseUrl: flag('base-url')! } : {}),
        ...(context ? { contextTokens: Number(context) } : {}),
        ...(enabled !== undefined ? { enabled: enabled === 'true' } : {}),
        ...(flag('reason') !== undefined ? { reason: flag('reason')! } : {}),
        ...(jobs !== undefined ? { jobs: parseJobs(jobs) } : {}),
        ...(prefer !== undefined ? { preferredJobs: parseJobs(prefer) ?? [] } : {}),
        ...(maxConcurrent !== undefined ? { maxConcurrent: Number(maxConcurrent) } : {}),
      }
    }
    if (sub === 'add') {
      const input = mutation()
      if (!input.model) {
        const configuredModel = process.env.ORCH_LOCAL_MODEL?.trim()
        if (!configuredModel) {
          throw new Error(
            'agent add requires --model or ORCH_LOCAL_MODEL\n' +
            'cleared by: pass --model or set ORCH_LOCAL_MODEL',
          )
        }
        input.model = configuredModel
      }
      console.log(JSON.stringify(addAgent(name!, input)))
    }
    else if (sub === 'set') console.log(JSON.stringify(setAgent(name!, mutation())))
    else if (sub === 'remove') { removeAgent(name!); console.log(`removed ${name}`) }
    else if (sub === 'probe') {
      const result = await probeAgent(name!)
      console.log(JSON.stringify(result, null, 2))
      if (!result.ok) process.exitCode = 1
    }
    else if (sub === 'show') {
      const row = agentRows().find((candidate) => candidate.name === name)
      if (!row) throw new Error(`unknown agent "${name}"`)
      const judged = db().query(
        `SELECT job, COUNT(*) AS count FROM run r JOIN score s ON s.run_id=r.id WHERE r.agent=? GROUP BY job ORDER BY job`,
      ).all(name) as { job: string; count: number }[]
      console.log(JSON.stringify({
        ...row, caps: JSON.parse(row.caps),
        probeResult: row.probe_result ? JSON.parse(row.probe_result) : null, judged,
      }, null, 2))
    }
    else if (sub === 'list') {
      const rows = agentRows().map((row) => {
        const caps = JSON.parse(row.caps)
        const understandMinimum = 147_456
        return {
          name: row.name, harness: row.harness, backend: row.backend, model: row.model,
          baseUrl: row.base_url, transport: row.transport, caps, billing: row.billing,
          enabled: Boolean(row.enabled), disabledReason: row.disabled_reason,
          jobs: row.jobs ? JSON.parse(row.jobs) : null,
          preferredJobs: row.preferred_jobs ? JSON.parse(row.preferred_jobs) : [],
          maxConcurrent: row.max_concurrent,
          probedAt: row.probed_at, probeResult: row.probe_result ? JSON.parse(row.probe_result) : null,
          legacy: !['codex','grok','opencode','goose','claude-code'].includes(row.harness),
          limitation: row.name === 'local-acp' && Number(caps.contextTokens ?? 0) < understandMinimum
            ? `understand requires the endpoint served at ${understandMinimum} tokens or more`
            : null,
          eligibility: row.probe_result && JSON.parse(row.probe_result).ok === false
            ? 'ineligible: registration probe failed'
            : !Object.hasOwn(caps, 'contextTokens')
            ? 'ineligible: no declared or probed context window'
            : !row.probed_at
            ? 'inline only: unprobed and ineligible for repository jobs'
            : row.enabled ? 'eligible by registration' : `ineligible: disabled — ${row.disabled_reason}`,
        }
      })
      if (process.argv.includes('--json')) console.log(JSON.stringify(rows))
      else for (const row of rows) {
        console.log(
          `${row.name.padEnd(12)} ${row.enabled ? 'enabled ' : 'disabled'} ` +
          `${row.harness}/${row.backend ?? '-'} ${row.model}` +
          `${row.legacy ? ' [legacy]' : ''} — ${row.eligibility}` +
          `; jobs ${row.jobs?.join(',') ?? 'any'}; prefer ${row.preferredJobs.join(',') || '-'}; cap ${row.maxConcurrent ?? 'none'}` +
          `${row.limitation ? `; ${row.limitation}` : ''}`,
        )
      }
    }
    break
  }

  case 'agents':
    await loadAgents()
    await ensureLocalHealth()
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(Object.values(AGENTS).map((a) => ({
        name: a.name,
        caps: a.caps,
        model: a.model,
        contextTokens: Number.isFinite(a.contextTokens) ? a.contextTokens : null,
        maxPromptBytes: Number.isFinite(a.maxPromptBytes) ? a.maxPromptBytes : null,
        timeoutMs: a.timeoutMs,
      }))))
      break
    }
    for (const a of Object.values(AGENTS)) {
      console.log(
        `${a.name.padEnd(7)} ${available(a.name) ? 'installed' : 'MISSING  '} ${a.billing.padEnd(13)}` +
          (unavailableReason(a.name) ? ` [${unavailableReason(a.name)}]` : '') +
          ` repo=${a.caps.readsRepo ? 'y' : 'n'} mcp=${a.caps.mcp ? 'y' : 'n'} schema=${a.caps.schema ? 'y' : 'n'}  ${a.notes}`,
      )
    }
    console.log(`\ninstalled: ${installed().join(', ') || 'none'}`)
    break

  default:
    usage()
}

} catch (e) {
  // A run that failed already recorded itself; the throw is how `orch do`
  // signals it to a shell, so the exit code still has to be non-zero.
  console.error((e as Error).message)
  process.exit(1)
}
