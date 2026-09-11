import { db, writableDb, sessionId, recordSessionSeen } from './db.ts'; import { registerStandardRuntime } from './runtime-registration.ts'; registerStandardRuntime()
import { pendingForSession } from './evidence-query.ts'
import { REVIEW_REPRODUCED, REVIEW_COVERAGE, REVIEW_LIMITS, REVIEW_OVERLAP, REVIEW_SEVERITY } from './review-vocabulary.ts'
import { reapStale } from './run-liveness.ts'; import { pidAlive } from './process-liveness.ts'
import { unrecordedPairsForSession } from './duel.ts'
import { authorizeRunMutation } from './run-authority.ts'
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
import { canonCommand } from './canon-commands.ts'
import { dispatchCommand } from './dispatch-commands.ts'
import { reclassifyFailuresCommand } from './failure-commands.ts'
import { blockersCommand, healthCommand } from './health-commands.ts'
import { guideCommand, pickCommand, routingBacktestCommand, statsCommand } from './routing-commands.ts'
import { readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync, lstatSync, openSync, fstatSync, closeSync, constants } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { NOT_EVIDENCE } from './failure.ts'
import { collectResult, collectWait, resolveFailover, thinOutputWarning } from './collect.ts'
import {
  CONTINUE_WORKING_FORMS, TELL_WORKING_FORMS,
  flagValue, flagValues, parseWorkerMessageArgs, validateCliArgs,
  assertWorkerText, readMessageText, readWorkerFile,
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

let jobsModule: typeof import('./jobs.ts')
let agentsModule: typeof import('./agents.ts')
let routeModule: typeof import('./route.ts')
let runArtifactsModule: typeof import('./run-artifacts.ts'); let closeOutModule: typeof import('./close-out.ts')
let reviewTargetModule: typeof import('./review-target.ts')
let implicitReviewWarning!: typeof import('./review-target.ts').implicitReviewWarning
let worktreeModule!: typeof import('./worktree.ts')
let contractModule!: typeof import('./contract.ts')
let grokTrustModule!: typeof import('./grok-trust.ts')
let workflowsModule!: typeof import('./workflows.ts')
let agreementModule!: typeof import('./agreement.ts')

let JOBS!: typeof import('./jobs.ts').JOBS
let job!: typeof import('./jobs.ts').job
let jobBoundInstructionForContract!: typeof import('./jobs.ts').jobBoundInstructionForContract
let jobTimeoutHelp!: typeof import('./jobs.ts').jobTimeoutHelp
async function loadJobs() {
  jobsModule ??= await import('./jobs.ts')
  ;({ JOBS, job, jobBoundInstructionForContract, jobTimeoutHelp } = jobsModule)
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
async function loadRoute() { routeModule ??= await import('./route.ts'); ({ candidates, pick } = routeModule) }
let RUNS_DIR!: typeof import('./run-artifacts.ts').RUNS_DIR
let terminateRunProcesses!: typeof import('./run-process.ts').terminateRunProcesses
let closeOutRun!: typeof import('./close-out.ts').closeOutRun
async function loadRun() { runArtifactsModule ??= await import('./run-artifacts.ts'); closeOutModule ??= await import('./close-out.ts')
  reviewTargetModule ??= await import('./review-target.ts'); ({ implicitReviewWarning } = reviewTargetModule)
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
async function loadAgreement() { agreementModule ??= await import('./agreement.ts') }

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

function argvResumeLimit(agentName: string): number | undefined {
  const agent = AGENTS[agentName]
  if (!agent?.resumeArgv) return undefined
  return resumePromptByteLimit(agent)
}

/**
 * One reader for the free-text body that reaches a worker: positional text,
 * or --file PATH, or stdin when neither is given and stdin is not a TTY.
 */
const runAnswerHelpers = {
  argvResumeLimit, assertWorkerText, readWorkerFile, readMessageText,
  presentation: { dur, scoreHint, argvResumeLimit, printRunId },
}

async function readPrompt(): Promise<string> {
  return (await readMessageText({
    missing: 'no prompt: pass it as an argument, via --file, or on stdin',
    sources: { commandFile: flag('file'), positionals: positionalMessage(argv.slice(2)) },
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
    await canonCommand(argv, { has, flag }, { log: console.log, exitCode: (code) => { process.exitCode = code }, cwd: process.cwd })
    break
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
    await dispatchCommand(
      argv,
      { has, flag, values: flags },
      {
        usage, doUsage, error: console.error, printRunId, readPrompt,
        validateSchema: readStrictCodexSchema, warnCallerDrift, contractConflicts,
        warnImplementContractConflicts, checkoutHasUncommittedWork, resolveBase,
        implicitReviewWarning,
        // Dispatch composes the routing pick and transport eligibility at the CLI adapter.
        resolveDispatchOptions: async (jobName) => {
          const selectedRow = flag('agent') ? AGENTS[flag('agent')!] : undefined; const transportFlag = flag('transport')
          const transportExplicit = transportFlag !== undefined || Boolean(process.env.ORCH_TRANSPORT)
          const transport = !transportExplicit && selectedRow
            ? selectedRow.defaultTransport
            : resolveTransportName(transportFlag)
          if (transport === 'acp') {
            assertAcpAllowed(jobName, flag('agent'), selectedRow)
            assertAcpReady(flag('agent') ?? 'codex', selectedRow)
          }
          const agent = selectAgentForTransport(transport, flag('agent'))
          const { avoid, distinctModels } = await routeConstraints(flag('agent'))
          return { agent, transport, transportExplicit, avoid, distinctModels, mcp: requestedMcp() }
        },
        detach, follow,
      },
    )
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
    collectResult(db(), argv, scoreSuffix, { log: (...values) => console.log(...values), error: (...values) => console.error(...values), exit: (code): never => process.exit(code) })
    const id = Number(argv[1])
    const chain = resolveFailover(db(), id)
    const row = db().query(
      `SELECT job, status, latency_ms, probe, output_path FROM run WHERE id=?`,
    ).get(chain.finalId) as {
      job: string; status: string; latency_ms: number | null; probe: number
      output_path: string | null
    }
    const warning = thinOutputWarning({ ...row, writesRepo: Boolean(job(row.job).needs.writesRepo) })
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

  case 'blockers': {
    blockersCommand({ has, flag }, { log: console.log })
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
    await Promise.all([loadJobs(), loadAgents()])
    routingBacktestCommand({ has, flag }, { log: console.log, dur })
    break
  }

  case 'runs': {
    await loadJobs()
    const options = { jsonV1: argv.includes('--json=v1') }
    const commandFlags = { has, flag, values: flags }
    const presentation = {
      log: console.log, dur, chainIsStranded, strandedRecovery,
      thinOutputWarning: (row: { job: string; status: string; latency_ms: number | null; probe: number; output_path: string | null }) =>
        thinOutputWarning({ ...row, writesRepo: Boolean(job(row.job).needs.writesRepo) }),
    }
    await runListingCommand(options, commandFlags, presentation)
    break
  }

  case 'guide': {
    await Promise.all([loadJobs(), loadAgents(), loadRoute()])
    await ensureLocalHealth()
    guideCommand({ has, flag }, { log: console.log, dur })
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
    statsCommand({ has, flag }, { log: console.log, dur })
    break
  }

  case 'pick': {
    await Promise.all([loadJobs(), loadAgents(), loadRoute(), loadRun(), loadWorktree(), loadTransport()])
    await ensureLocalHealth()
    const jobName = argv[1]
    if (!jobName) usage()
    if (job(jobName).needs.readsRepo) warnCallerDrift(process.cwd())
    const { stackAt } = await import('./projects.ts')
    const stack = flag('stack') ?? stackAt(process.cwd())
    // Pick composes transport eligibility with routing at the CLI adapter.
    const { avoid, distinctModels } = await routeConstraints(flag('agent'))
    const lens = flag('lens')
    const transport = resolveTransportName(flag('transport'))
    if (transport === 'acp') assertAcpAllowed(jobName, flag('agent'), flag('agent') ? AGENTS[flag('agent')!] : undefined)
    const selectedAgent = selectAgentForTransport(transport, flag('agent'))
    pickCommand(
      { jobName, stack, avoid, distinctModels, lens, selectedAgent },
      { has, flag },
      { log: console.log, agents: AGENTS },
    )
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

  case 'reclassify-failures': {
    await loadJobs()
    reclassifyFailuresCommand({ has }, { log: console.log })
    break
  }

  case 'health': {
    healthCommand({ has, flag }, { log: console.log })
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
