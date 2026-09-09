import { Database } from 'bun:sqlite'
import { DATABASE_RESOLUTION, DB_PATH, db, writableDb, databaseOpenMode, nowIso, sessionId, judgeability, pendingForSession, weigh,
         DELIVERY, QUALITY, FIDELITY, type Delivery, type Quality, type Fidelity,
         REVIEW_REPRODUCED, REVIEW_COVERAGE, REVIEW_LIMITS, REVIEW_OVERLAP,
         REVIEW_SEVERITY,
         type ReviewReproduced, type ReviewCoverage, type ReviewLimits, type ReviewOverlap,
         reapStale, pidAlive, STALE_AFTER_MS, UNSCORED_WHERE, recordDuels, recordLosses, recordTies, duelMatrices,
         pairPartners, unrecordedPairsForSession, parseRunIds, recordSessionSeen, SESSION_LIVE_MS,
         resolveRootFromLastTurn, chainScoreJoin,
         EVIDENCE_CLOSED_SQL, voidedSql, activeSql, runTotals,
         authorizeRunMutation, runMutationActor,
         auditRunMutation, adoptRunMutation, writeTransaction, tryWriteContention,
         evidenceOwningWorktreeSharers,
         teardownTerminalRunResources,
         terminalDockerRetentionReasonForRun,
         type WorktreeSharerRow, type RootAuthority } from './db.ts'
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, realpathSync, statSync, lstatSync, unlinkSync, openSync, fstatSync, closeSync, constants } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { projectAt, projectByName, projects, renameProject } from './projects.ts'
import { classify, NOT_EVIDENCE, type FailureKind } from './failure.ts'
import { collectResult, collectWait, resolveFailover, failoverSummary } from './collect.ts'
import { failureReason, outcomeOf, type OutcomeRow } from './outcome.ts'
import {
  ANSWER_WORKING_FORMS, CONTINUE_WORKING_FORMS, TELL_WORKING_FORMS,
  flagValue, flagValues, invalidUtf8Offset, nulByteOffset, parseAnswerTextSources,
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

type DetachSpec = import('./run.ts').DetachSpec
type McpRequest = import('./run.ts').McpRequest
type Worktree = import('./worktree.ts').Worktree
type Disposition = import('./review.ts').Disposition
type ReviewGrades = import('./review.ts').ReviewGrades
type RoutingBacktest = import('./routing-backtest.ts').RoutingBacktest
type DockerResource = import('./docker-resources.ts').DockerResource

let jobsModule: typeof import('./jobs.ts')
let agentsModule: typeof import('./agents.ts')
let routeModule: typeof import('./route.ts')
let guideModule: typeof import('./guide.ts')
let runModule: typeof import('./run.ts')
let worktreeModule!: typeof import('./worktree.ts')
let contractModule!: typeof import('./contract.ts')
let grokTrustModule!: typeof import('./grok-trust.ts')
let reviewModule!: typeof import('./review.ts')
let reviewTierModule!: typeof import('./review-tier.ts')
let workflowsModule!: typeof import('./workflows.ts')
let agreementModule!: typeof import('./agreement.ts')
let routingBacktestModule!: typeof import('./routing-backtest.ts')
let dockerResourcesModule!: typeof import('./docker-resources.ts')

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
let tryWake!: typeof import('./agents.ts').tryWake
let wakeStatus!: typeof import('./agents.ts').wakeStatus
let lastWakeAttempt!: typeof import('./agents.ts').lastWakeAttempt
let readStrictCodexSchema!: typeof import('./agents.ts').readStrictCodexSchema
let resumePromptByteLimit!: typeof import('./agents.ts').resumePromptByteLimit
let cliVersion!: typeof import('./agents.ts').cliVersion
let versionBelow!: typeof import('./agents.ts').versionBelow
let agentRows!: typeof import('./agents.ts').agentRows
let addAgent!: typeof import('./agents.ts').addAgent
let setAgent!: typeof import('./agents.ts').setAgent
let removeAgent!: typeof import('./agents.ts').removeAgent
let probeAgent!: typeof import('./agents.ts').probeAgent
let fileContractProbeReason!: typeof import('./agents.ts').fileContractProbeReason
let predatesFileContract!: typeof import('./agents.ts').predatesFileContract
async function loadAgents() {
  agentsModule ??= await import('./agents.ts')
  ;({ AGENTS, available, installed, ensureLocalHealth, unavailableReason, tryWake,
      wakeStatus, lastWakeAttempt, readStrictCodexSchema, resumePromptByteLimit,
      cliVersion, versionBelow, agentRows, addAgent, setAgent, removeAgent, probeAgent,
      fileContractProbeReason, predatesFileContract } = agentsModule)
}
let candidates!: typeof import('./route.ts').candidates
let pick!: typeof import('./route.ts').pick
let scoreboard!: typeof import('./route.ts').scoreboard
let MIN_SAMPLE!: typeof import('./route.ts').MIN_SAMPLE
let promptSizeBucketLabel!: typeof import('./route.ts').promptSizeBucketLabel
async function loadRoute() { routeModule ??= await import('./route.ts'); ({ candidates, pick, scoreboard, MIN_SAMPLE, promptSizeBucketLabel } = routeModule) }
let guide!: typeof import('./guide.ts').guide
async function loadGuide() { guideModule ??= await import('./guide.ts'); ({ guide } = guideModule) }
let repoOf!: typeof import('./run.ts').repoOf
let preflight!: typeof import('./run.ts').preflight
let preflightMcp!: typeof import('./run.ts').preflightMcp
let KEEP_RUN_FILES_DAYS!: typeof import('./run.ts').KEEP_RUN_FILES_DAYS
let RUNS_DIR!: typeof import('./run.ts').RUNS_DIR
let runFilePaths!: typeof import('./run.ts').runFilePaths
let terminateRunProcesses!: typeof import('./run.ts').terminateRunProcesses
let implicitReviewWarning!: typeof import('./run.ts').implicitReviewWarning
let packedResumePrompt!: typeof import('./run.ts').packedResumePrompt
let mcpRequestFromStored!: typeof import('./run.ts').mcpRequestFromStored
let storedMcpRequest!: typeof import('./run.ts').storedMcpRequest
let retryModelForAgent!: typeof import('./run.ts').retryModelForAgent
let chainTransport!: typeof import('./run.ts').chainTransport
let closeOutRun!: typeof import('./run.ts').closeOutRun
let readDispatchState!: typeof import('./run.ts').readDispatchState
async function loadRun() { runModule ??= await import('./run.ts'); ({ repoOf, preflight, preflightMcp, KEEP_RUN_FILES_DAYS, RUNS_DIR, runFilePaths, terminateRunProcesses, implicitReviewWarning, packedResumePrompt, mcpRequestFromStored, storedMcpRequest, retryModelForAgent, chainTransport, readDispatchState, closeOutRun } = runModule) }
let transportModule: typeof import('./transport.ts')
let assertAcpAllowed!: typeof import('./transport.ts').assertAcpAllowed
let assertAcpReady!: typeof import('./transport.ts').assertAcpReady
let resolveTransportName!: typeof import('./transport.ts').resolveTransportName
let selectAgentForTransport!: typeof import('./transport.ts').selectAgentForTransport
async function loadTransport() {
  transportModule ??= await import('./transport.ts')
  ;({ assertAcpAllowed, assertAcpReady, resolveTransportName, selectAgentForTransport } = transportModule)
}
let branchTip!: typeof import('./worktree.ts').branchTip
let contentTree!: typeof import('./worktree.ts').contentTree
let restoreBranch!: typeof import('./worktree.ts').restoreBranch
let resolveBase!: typeof import('./worktree.ts').resolveBase
let repoRootOf!: typeof import('./worktree.ts').repoRootOf
let removeBranch!: typeof import('./worktree.ts').removeBranch
let removeFor!: typeof import('./worktree.ts').removeFor
let unmergedBranch!: typeof import('./worktree.ts').unmergedBranch
let checkoutHasUncommittedWork!: typeof import('./worktree.ts').checkoutHasUncommittedWork
let callerDrift!: typeof import('./worktree.ts').callerDrift
let takeCleanupLock!: typeof import('./worktree.ts').withCleanupLock
let withWorktreeLease!: typeof import('./worktree.ts').withWorktreeLease
let targetGitEnvironment!: typeof import('./worktree.ts').targetGitEnvironment
let worktreeDirty!: typeof import('./worktree.ts').worktreeDirty
async function loadWorktree() { worktreeModule ??= await import('./worktree.ts'); ({ branchTip, contentTree, restoreBranch, resolveBase, repoRootOf, removeBranch, removeFor, unmergedBranch, checkoutHasUncommittedWork, callerDrift, withCleanupLock: takeCleanupLock, withWorktreeLease, targetGitEnvironment, worktreeDirty } = worktreeModule) }
let WORKER_PREAMBLE!: typeof import('./contract.ts').WORKER_PREAMBLE
let READONLY_PREAMBLE!: typeof import('./contract.ts').READONLY_PREAMBLE
let NO_REPO_PREAMBLE!: typeof import('./contract.ts').NO_REPO_PREAMBLE
let REVIEW_SEVERITY_INSTRUCTION!: typeof import('./contract.ts').REVIEW_SEVERITY_INSTRUCTION
let contractConflicts!: typeof import('./contract.ts').contractConflicts
let rulingPrompt!: typeof import('./contract.ts').rulingPrompt
async function loadContract() { contractModule ??= await import('./contract.ts'); ({ WORKER_PREAMBLE, READONLY_PREAMBLE, NO_REPO_PREAMBLE, REVIEW_SEVERITY_INSTRUCTION, contractConflicts, rulingPrompt } = contractModule) }
let grokTrustHeadings!: typeof import('./grok-trust.ts').grokTrustHeadings
let grokTrustPathFromHeading!: typeof import('./grok-trust.ts').grokTrustPathFromHeading
async function loadGrokTrust() { grokTrustModule ??= await import('./grok-trust.ts'); ({ grokTrustHeadings, grokTrustPathFromHeading } = grokTrustModule) }
let cleanReviewEvidence!: typeof import('./review.ts').cleanReviewEvidence
let completeReview!: typeof import('./review.ts').completeReview
let coverageAudit!: typeof import('./review.ts').coverageAudit
let DISPOSITIONS!: typeof import('./review.ts').DISPOSITIONS
let gradeReviewLens!: typeof import('./review.ts').gradeReviewLens
let parseReviewOutput!: typeof import('./review.ts').parseReviewOutput
let recordReviews!: typeof import('./review.ts').recordReviews
let getReview!: typeof import('./review.ts').getReview
let listReviews!: typeof import('./review.ts').listReviews
let MIN_REVIEW_TRIAGED!: typeof import('./review.ts').MIN_REVIEW_TRIAGED
let REVIEW_WINDOW!: typeof import('./review.ts').REVIEW_WINDOW
let reviewCalibration!: typeof import('./review.ts').reviewCalibration
let reviewCalibrationFleet!: typeof import('./review.ts').reviewCalibrationFleet
let reviewPins!: typeof import('./review.ts').reviewPins
let triageFinding!: typeof import('./review.ts').triageFinding
async function loadReview() { reviewModule ??= await import('./review.ts'); ({ cleanReviewEvidence, completeReview, coverageAudit, DISPOSITIONS, gradeReviewLens, parseReviewOutput, recordReviews, getReview, listReviews, MIN_REVIEW_TRIAGED, REVIEW_WINDOW, reviewCalibration, reviewCalibrationFleet, reviewPins, triageFinding } = reviewModule) }
let classifyReviewTier!: typeof import('./review-tier.ts').classifyReviewTier
let diffNumstat!: typeof import('./review-tier.ts').diffNumstat
async function loadReviewTier() { reviewTierModule ??= await import('./review-tier.ts'); ({ classifyReviewTier, diffNumstat } = reviewTierModule) }
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
let gwetAc1!: typeof import('./agreement.ts').gwetAc1
let quadraticWeightedKappa!: typeof import('./agreement.ts').quadraticWeightedKappa
async function loadAgreement() { agreementModule ??= await import('./agreement.ts'); ({ bradleyTerry, gwetAc1, quadraticWeightedKappa } = agreementModule) }
let routingBacktest!: typeof import('./routing-backtest.ts').routingBacktest
let routingBacktestEnsemble!: typeof import('./routing-backtest.ts').routingBacktestEnsemble
async function loadRoutingBacktest() { routingBacktestModule ??= await import('./routing-backtest.ts'); ({ routingBacktest, routingBacktestEnsemble } = routingBacktestModule) }
let dockerRemovalCommand!: typeof import('./docker-resources.ts').dockerRemovalCommand
let dockerRunResources!: typeof import('./docker-resources.ts').dockerRunResources
let leakedResourceLines!: typeof import('./docker-resources.ts').leakedResourceLines
let classifiedDockerResources!: typeof import('./docker-resources.ts').classifiedDockerResources
let orchRunId!: typeof import('./docker-resources.ts').orchRunId
let resourcesForRuns!: typeof import('./docker-resources.ts').resourcesForRuns
async function loadDockerResources() { dockerResourcesModule ??= await import('./docker-resources.ts'); ({ classifiedDockerResources, dockerRemovalCommand, dockerRunResources, leakedResourceLines, orchRunId, resourcesForRuns } = dockerResourcesModule) }

/**
 * How long `orch do` watches a detached run before handing it back.
 *
 * Derived, not guessed: every agent's own timeout is held below STALE_AFTER_MS
 * (asserted in the suite), and the reaper sweeps anything older, so a run has
 * always reached a terminal state by then. The extra minute is for the reaper's
 * own poll to land.
 */
const FOLLOW_TIMEOUT_MS = STALE_AFTER_MS + 60_000

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
 * Watch a detached run to its terminal state and report it as the caller expects.
 *
 * Shared by `do` and `retry` because they have the same exposure: whichever
 * process is holding the agent as a child is the process whose death destroys
 * the work. Neither holds it any more.
 */
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
function evidenceNote(row: { evidence_excluded: string | null }): string {
  return row.evidence_excluded
    ? `\n  not routing evidence: ${row.evidence_excluded}`
    : ''
}

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
  const deadline = Date.now() + FOLLOW_TIMEOUT_MS
  const q = db().query(
    `SELECT id, status, agent, job, parent_run_id, latency_ms, vendor_tokens,
            output_path, error, route_reason, evidence_excluded
       FROM run WHERE id = ?`)
  for (;;) {
    const chain = resolveFailover(db(), id)
    const row = q.get(chain.finalId) as {
      id: number; status: string; agent: string; job: string; parent_run_id: number | null
      latency_ms: number | null; vendor_tokens: number | null
      output_path: string | null; error: string | null; route_reason: string | null
      evidence_excluded: string | null
    } | null
    const outcome = row ? outcomeOf(row) : null
    if (row && outcome?.terminal && !chain.settling) {
      const out = row.output_path && existsSync(row.output_path)
        ? readFileSync(row.output_path, 'utf8') : ''
      if (out) console.log(out)
      const failover = failoverSummary(chain.attempts)
      if (failover) console.error(`\n— ${failover}`)
      /**
       * ASKING IS NOT A FAILURE, and printing it as one undoes the rename.
       *
       * A worker that stopped to get a decision did exactly what it was told
       * to. This branch reported it as `asking: no output` and exited 1 — the
       * same shape as a crash, on the one outcome the whole escalation design
       * exists to produce. Its questions are the output; they are simply not in
       * the file this was looking at.
       */
      if (row.status === 'asking') {
        const open = db().query(
          `SELECT q.question FROM question q JOIN run r ON r.id = q.run_id
            WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL
            ORDER BY q.id`,
        ).all(row.parent_run_id ?? chain.finalId, row.parent_run_id ?? chain.finalId) as { question: string }[]
        console.error(
          `\n— run ${row.id} · ${row.agent} · stopped to ask` +
          (row.latency_ms ? ` after ${dur(row.latency_ms)}` : '') + '\n' +
          open.map((q) => `  · ${q.question}`).join('\n') +
          `\n\n  ${outcome.line}` +
          `\n  orch inbox              the questions in full` +
          `\n  orch answer ${row.parent_run_id ?? chain.finalId} ...   rule, and it resumes where it stopped` +
          `\n  orch diff ${row.parent_run_id ?? chain.finalId}          what it changed before it asked`,
        )
        return row.status
      }
      if (!outcome.ok) {
        if (exitOnFailure) {
          console.error(`\n— run ${row.id} · ${row.agent} · ${row.status}: ${row.error ?? 'no output'}`)
          process.exit(1)
        }
        return row.status
      }
      if (quiet) return row.status
      console.error(
        `\n— run ${row.id} · ${row.agent}` +
          (row.route_reason ? ` (${row.route_reason})` : '') +
          ` · ${dur(row.latency_ms ?? 0)}` +
          (row.vendor_tokens ? ` · ${row.vendor_tokens.toLocaleString()} vendor tokens` : '') +
          `\n  score it:  ${scoreHint(chain.finalId, row.job, row.parent_run_id)}` +
          evidenceNote(row),
      )
      return row.status
    }
    if (Date.now() >= deadline) {
      // Deliberately NOT a kill. The worker is detached and may still be
      // working; saying where to look for it is more use than destroying it.
      console.error(`— run ${id} still going after ${Math.round(FOLLOW_TIMEOUT_MS / 60_000)}m.`
        + ` It is detached and will finish on its own:  orch run ${id}`)
      process.exit(2)
    }
    const observed = reapStale()
    if (Array.isArray(observed) && observed.some((dead) => dead.id === chain.finalId)) {
      console.error(`run ${chain.finalId}: process gone, not terminalised (read-only linked worktree)`)
      if (exitOnFailure) process.exitCode = 1
      return row?.status ?? 'running'
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
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

function recordScoreVerdict(
  id: number, delivery: Delivery, quality: Quality | null, fidelity: Fidelity | null,
  note: string | null, scoredAt: string, scorer: string,
): void {
  db().query(
    `INSERT INTO score (run_id, delivery, quality, fidelity, note, scored_at, scored_by)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(run_id) DO UPDATE SET delivery=excluded.delivery, quality=excluded.quality,
                                       fidelity=excluded.fidelity,
                                       note=CASE
                                         WHEN score.note IS NULL OR trim(score.note) = ''
                                           THEN excluded.note
                                         WHEN excluded.note IS NULL OR trim(excluded.note) = ''
                                           THEN score.note
                                         ELSE score.note || '\n\n--- re-scored ' ||
                                           excluded.scored_at || ' ---\n' || excluded.note
                                       END,
                                       scored_at=excluded.scored_at`,
  ).run(id, delivery, quality, fidelity, note, scoredAt, scorer)
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

type CleanupRow = {
  id: number; repo?: string | null; cwd?: string | null
  worktree: string; branch: string | null
  base_commit: string | null
  worktree_source?: 'recipe' | 'git' | 'readonly_recipe' | null
  minted_branch?: string | null
}

type BranchOwnerRow = {
  id: number; repo: string | null; cwd: string | null; worktree: string | null
  status: string; scored: number; evidence_excluded?: string | null
}

class SharedWorktreeEvidenceError extends Error {
  constructor(readonly worktree: string, readonly sharers: WorktreeSharerRow[]) {
    super(
      `worktree ${worktree} is actively used by other runs:\n` +
      sharers.map((row) => `  run ${row.id} is ${row.status}`).join('\n'),
    )
  }
}

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
const KEPT_ROW_LIMIT = 10

function orphanKeepReason(detail: string): string {
  return /^has commits not reachable from /.test(detail)
    ? 'holds commits not on trunk'
    : detail
}

type NamedRun = { id: number; status: string }

function templateRunId(name: string, branchTemplate?: string): number | null {
  const conventional = name.match(/^orch-(\d+)$/)
  if (conventional) return Number(conventional[1])
  if (!branchTemplate?.includes('{id}')) return null

  let idGroup = 0
  const parts = basename(branchTemplate).split(/(\{id\}|\{key\})/g)
  const pattern = parts.map((part) => {
    if (part === '{id}') {
      idGroup++
      return idGroup === 1 ? '(\\d+)' : '\\d+'
    }
    if (part === '{key}') return '[^/]+'
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }).join('')
  const match = name.match(new RegExp(`^${pattern}$`))
  return match?.[1] ? Number(match[1]) : null
}

function pathIsUnder(path: string | null, root: string): boolean {
  if (!path) return false
  const candidate = resolve(path)
  const project = resolve(root)
  return candidate === project || candidate.startsWith(`${project}/`)
}

function namedRun(
  name: string, branchTemplate: string | undefined, project: { name: string; path: string },
): NamedRun | null {
  const runId = templateRunId(name, branchTemplate)
  if (runId === null) return null
  const member = db().query(
    'SELECT id, parent_run_id, repo, cwd, worktree FROM run WHERE id=?',
  ).get(runId) as {
    id: number; parent_run_id: number | null; repo: string | null
    cwd: string | null; worktree: string | null
  } | null
  if (!member) return null
  const belongs = member.repo === project.name ||
    (member.repo === null &&
      (pathIsUnder(member.cwd, project.path) || pathIsUnder(member.worktree, project.path)))
  if (!belongs) return null

  const rootId = member.parent_run_id ?? member.id
  const latest = db().query(
    `SELECT status FROM run
      WHERE id=? OR parent_run_id=?
      ORDER BY turn DESC, id DESC LIMIT 1`,
  ).get(rootId, rootId) as { status: string }
  return { id: member.id, status: latest.status }
}

function printSweepKept(
  done: number,
  kept: { line: string; reason: string }[],
  dry: boolean,
): void {
  console.log(`\n${dry ? 'would reclaim' : 'reclaimed'} ${done}, kept ${kept.length}`)
  const listAll = dry
  const fits = kept.length <= KEPT_ROW_LIMIT
  const showSummary = listAll || !fits
  const showRows = listAll || fits
  if (showSummary && kept.length > 0) {
    const counts = new Map<string, number>()
    for (const row of kept) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1)
    const grouped = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const width = String(grouped[0]![1]).length
    for (const [reason, n] of grouped) {
      console.log(`  ${String(n).padStart(width)}  ${reason}`)
    }
  }
  if (showRows) {
    for (const row of kept) console.log(`  ${row.line}`)
  } else {
    const parts = ['orch sweep --dry-run']
    if (has('force')) parts.push('--force')
    console.log(`  ${parts.join(' ')} lists every kept row`)
  }
}

function cleanupRepoRoot(row: {
  worktree?: string | null; cwd?: string | null; repo?: string | null
}): string | null {
  const registered = row.repo ? projectByName(row.repo)?.path : null
  const builtInRoot = row.worktree?.includes('/.claude/worktrees/')
    ? row.worktree.slice(0, row.worktree.indexOf('/.claude/worktrees/')) : null
  return registered ?? repoRootOf(row.worktree ?? '') ?? repoRootOf(row.cwd ?? '')
    ?? (builtInRoot ? repoRootOf(builtInRoot) : null) ?? repoRootOf(process.cwd())
}

function samePath(a: string, b: string): boolean {
  const normalized = (path: string) => {
    const value = existsSync(path) ? realpathSync(path) : resolve(path)
    return value.replace(/\/$/, '')
  }
  return normalized(a) === normalized(b)
}

/** A branch is shared only inside one repository, and active owners protect it. */
function evidenceOwningBranchOwners(
  row: { id: number; repo?: string | null; branch: string | null }, repoRoot: string,
  branchTipBeforeRemoval?: string | null,
): BranchOwnerRow[] {
  if (!row.branch) return []
  const project = row.repo ?? projectAt(repoRoot)?.name ?? null
  const candidates = db().query(
    `SELECT r.id, COALESCE(r.parent_run_id, r.id) AS root_id,
            r.repo, r.cwd, r.worktree, r.status, r.evidence_excluded,
            ${EVIDENCE_CLOSED_SQL} AS scored
       FROM run r ${chainScoreJoin('r', 's')}
      WHERE r.branch=?
        AND COALESCE(r.parent_run_id, r.id) <>
            COALESCE((SELECT COALESCE(parent_run_id, id) FROM run WHERE id=?), ?)
        AND r.status IN ('running','asking')
      ORDER BY r.id`,
  ).all(row.branch, row.id, row.id) as (BranchOwnerRow & { root_id: number })[]
  const matching = candidates.filter((candidate) => {
    if (project && candidate.repo && candidate.repo !== project) return false
    const candidateRoot = candidate.repo ? projectByName(candidate.repo)?.path : null
    const discovered = candidateRoot ?? repoRootOf(candidate.worktree ?? '') ??
      repoRootOf(candidate.cwd ?? '')
    if (!discovered || !samePath(discovered, repoRoot)) return false
    if ((candidate.status === 'failed' || candidate.evidence_excluded) && candidate.repo) {
      const trunk = projectByName(candidate.repo)?.settings.trunk
      if (typeof trunk === 'string') {
        const cherry = Bun.spawnSync(['git', 'cherry', trunk, branchTipBeforeRemoval ?? row.branch!], {
          cwd: repoRoot, env: targetGitEnvironment(repoRoot), stdout: 'pipe', stderr: 'pipe',
        })
        if (cherry.exitCode === 0) {
          const commits = cherry.stdout.toString().trim().split('\n').filter(Boolean)
          if (commits.every((line) => line.startsWith('-'))) return false
        }
      }
    }
    return true
  })
  const roots = new Set<number>()
  return matching.flatMap((candidate) => {
    if (roots.has(candidate.root_id)) return []
    roots.add(candidate.root_id)
    return [{ ...candidate, id: candidate.root_id }]
  })
}

function withCleanupLock<T>(
  repoRoot: string, what: string, worktreePath: string | null | undefined, action: () => T,
): T {
  const run = () => takeCleanupLock(
    repoRoot, { session: sessionId(), what: `cleanup ${what}` }, action, 5 * 60_000,
  )
  if (!worktreePath) return run()
  return withWorktreeLease(
    repoRoot, worktreePath, { session: sessionId(), what: `tree ${what}` }, run, 5 * 60_000,
  )
}

/** One removed tree clears every pointer held by the same conversation. */
function clearConversationWorktree(
  runId: number, worktree: string, keptBranch: string | null = null,
): void {
  db().query(
    `UPDATE run
        SET worktree=NULL,
            branch_kept=CASE WHEN id=? THEN ? ELSE branch_kept END,
            branch_kept_tip=CASE WHEN id=? THEN NULL ELSE branch_kept_tip END
      WHERE worktree=?
        AND COALESCE(parent_run_id, id) =
            (SELECT COALESCE(parent_run_id, id) FROM run WHERE id=?)`,
  ).run(runId, keptBranch, runId, worktree, runId)
}

function resourcesForConversation(runId: number) {
  const ids = db().query(
    `SELECT id FROM run
      WHERE COALESCE(parent_run_id, id) =
            (SELECT COALESCE(parent_run_id, id) FROM run WHERE id=?)`,
  ).all(runId) as { id: number }[]
  return resourcesForRuns(ids.map((row) => row.id))
}

function recordRestoreRefusal(runId: number, branch: string, tip: string): void {
  db().query('UPDATE run SET branch_kept=?, branch_kept_tip=? WHERE id=?')
    .run(branch, tip, runId)
}

function restoreRefusal(
  runId: number, branch: string, tip: string, error: string,
): string {
  recordRestoreRefusal(runId, branch, tip)
  return `branch ${branch} should have been restored to ${tip}, but the ref write was refused: ` +
    `${error}. Restore it from the main checkout.`
}

function sharedBranchRefusal(
  runId: number, repoRoot: string, branch: string, snapshot: string, owner: BranchOwnerRow,
): { refusal: string | null; warning: string | null } {
  const after = branchTip(repoRoot, branch)
  if (after === snapshot) return { refusal: null, warning: null }
  if (after !== null) {
    return {
      refusal: `shared branch ${branch} moved from ${snapshot} to ${after} during cleanup; ` +
        `run ${owner.id} owns it, so it was left at ${after}`,
      warning: null,
    }
  }
  const restored = restoreBranch(repoRoot, branch, snapshot)
  return restored.ok ? {
    refusal: null,
    warning: `project remove tool deleted shared branch ${branch}; restored ${snapshot}. ` +
      'The tip at deletion was not observable.',
  } : {
    refusal: restoreRefusal(runId, branch, snapshot, restored.error),
    warning: null,
  }
}

function verifyBranchOwnershipAfterCleanup(
  runId: number, repoRoot: string, branch: string, snapshot: string | null,
  before: BranchOwnerRow[], after: BranchOwnerRow[],
): { refusal: string | null; warning: string | null } {
  const priorIds = new Set(before.map((owner) => owner.id))
  const acquired = after.find((owner) => !priorIds.has(owner.id)) ?? null
  const protector = acquired ?? after[0] ?? null
  let outcome = { refusal: null as string | null, warning: null as string | null }
  if (protector && snapshot) {
    outcome = sharedBranchRefusal(runId, repoRoot, branch, snapshot, protector)
  }
  if (!acquired) return outcome
  if (outcome.refusal) {
    return {
      refusal: `Run ${acquired.id} acquired branch ${branch} during cleanup; ${outcome.refusal}`,
      warning: null,
    }
  }
  const current = branchTip(repoRoot, branch)
  const location = current ? `left at ${current}` : 'absent with no pre-cleanup tip available to restore'
  return {
    refusal: `${outcome.warning ? `${outcome.warning} ` : ''}` +
      `Run ${acquired.id} acquired branch ${branch} during cleanup; cleanup was refused and the branch was ${location}.`,
    warning: null,
  }
}

/**
 * Release a run's worktree through the single path used by explicit cleanup.
 *
 * A WORKTREE NEED NOT BELONG TO ONE RUN, and assuming it did would have
 * deleted somebody's live work.
 *
 * orch names its trees `orch-<id>`, but a project's own script names them
 * however it likes — one project's tool derives the directory from the TICKET KEY, so
 * every run carrying `--key STAR-5084` lands in the same directory. Four
 * runs (665, 666, 668, 669) shared one tree, three of them blocked and one
 * actively working in it, and `orch discard 665` would have removed the
 * directory out from under run 669 mid-task. It was also that task's own
 * worktree, seeded, not a throwaway.
 *
 * So the tree goes only when no other active conversation is using it. A
 * non-terminal run may still be writing there. Refusal keeps every pointer
 * intact so a later cleanup can retry after those owners finish.
 *
 * The repo root is resolved from the worktree when it still exists, and
 * from HERE when it does not — `repoRootOf` on a deleted directory can
 * answer nothing, and the prune still needs somewhere to run. The pointer is
 * cleared ONLY if the tree actually went: clearing it after a failed removal
 * orphans the directory, still on disk, no longer named by any run, and
 * nothing left that knows to try again.
 */
function mintedBranchForCleanup(row: CleanupRow): string | null {
  if (row.minted_branch) return row.minted_branch
  try {
    const found = db().query(
      `SELECT minted_branch FROM run WHERE id=?`,
    ).get(row.id) as { minted_branch: string | null } | null
    if (found?.minted_branch) return found.minted_branch
    const chained = db().query(
      `SELECT minted_branch FROM run
        WHERE minted_branch IS NOT NULL AND (id=? OR parent_run_id=?)
        ORDER BY id LIMIT 1`,
    ).get(row.id, row.id) as { minted_branch: string | null } | null
    return chained?.minted_branch ?? null
  } catch { return null }
}

function discardWorktree(
  row: CleanupRow, verb: 'discarded' | 'abandoned', force = false,
  auditAuthority?: RootAuthority,
  forceBusy = false,
): void {
  const preliminarySharers = evidenceOwningWorktreeSharers(db(), row)
  if (preliminarySharers.length) {
    throw new SharedWorktreeEvidenceError(row.worktree, preliminarySharers)
  }
  const repoRoot = cleanupRepoRoot(row) ?? process.cwd()
  withCleanupLock(repoRoot, `${row.id}`, row.worktree, () => {
    const sharers = evidenceOwningWorktreeSharers(db(), row)
    if (sharers.length) {
      throw new SharedWorktreeEvidenceError(row.worktree, sharers)
    }

    const minted = mintedBranchForCleanup(row)
    const ownersBefore = evidenceOwningBranchOwners(row, repoRoot)
    const branchSnapshot = minted ? branchTip(repoRoot, minted) : null
    let protectedBranch: ReturnType<typeof unmergedBranch> = null
    let afterCutCount: number | null = null
    if (!force && minted) {
      protectedBranch = unmergedBranch(repoRoot, minted, null)
      afterCutCount = row.base_commit
        ? (unmergedBranch(repoRoot, minted, row.base_commit)?.count ?? 0)
        : null
    }
    if (auditAuthority) auditAuthority = adoptRunMutation(auditAuthority, 'discard')
    const r = removeFor({
      path: row.worktree,
      branch: minted ?? '',
      base: row.base_commit ?? '',
      repoRoot,
      source: row.worktree_source ?? undefined,
      mintedBranch: minted,
    }, repoRoot, force || forceBusy, ownersBefore.length > 0 || !minted, row.id, force && !forceBusy)
    const sharersAfter = evidenceOwningWorktreeSharers(db(), row)
    const ownersAfter = evidenceOwningBranchOwners(row, repoRoot, branchSnapshot)
    let branchWarning: string | null = null
    if (minted) {
      const ownership = verifyBranchOwnershipAfterCleanup(
        row.id, repoRoot, minted, branchSnapshot, ownersBefore, ownersAfter,
      )
      if (ownership.refusal) throw new Error(ownership.refusal)
      branchWarning = ownership.warning
    }
    if (sharersAfter.length) {
      throw new SharedWorktreeEvidenceError(row.worktree, sharersAfter)
    }
    if (protectedBranch && minted && ownersBefore.length === 0 && ownersAfter.length === 0) {
      const after = branchTip(repoRoot, minted)
      if (after !== null && after !== protectedBranch.tip) {
        throw new Error(
          `protected branch ${minted} moved from ${protectedBranch.tip} to ${after} during cleanup; ` +
          `it was left at ${after}`,
        )
      }
      if (after === null) {
        const restored = restoreBranch(repoRoot, minted, protectedBranch.tip)
        if (!restored.ok) {
          throw new Error(restoreRefusal(row.id, minted, protectedBranch.tip, restored.error))
        }
        branchWarning = `project remove tool deleted protected branch ${minted}; ` +
          `restored ${protectedBranch.tip}`
      }
    }
    if (!r.removed) throw new Error(r.detail)
    if (!minted && row.branch) {
      console.log(`branch ${row.branch} kept (review subject, not owned by run ${row.id})`)
    }
    if (branchWarning) console.error(branchWarning)
    const project = row.repo ?? projectAt(repoRoot)?.name ?? 'unknown'
    const inventory = resourcesForConversation(row.id)
    if (inventory.errors.length) {
      throw new Error(
        `project ${project}'s cleanup could not be verified — inventory unavailable:\n` +
        inventory.errors.map((error) => `  ${error}`).join('\n'),
      )
    }
    if (inventory.resources.length) {
      throw new Error(
        `project ${project}'s remove tool left Docker resources behind:\n` +
        leakedResourceLines(inventory.resources, project).map((line) => `  ${line}`).join('\n'),
      )
    }
    const keptProtectedBranch = protectedBranch && row.branch && branchTip(repoRoot, row.branch)
      ? row.branch : null
    writeTransaction(() => {
      clearConversationWorktree(row.id, row.worktree, keptProtectedBranch)
      if (auditAuthority) auditRunMutation(auditAuthority, 'discard', auditReason())
    })
    console.log(`${verb} run ${row.id}'s worktree`)
    if (r.output) console.log(r.output)
    if (protectedBranch && keptProtectedBranch) {
      console.log(keptBranchLine(
        keptProtectedBranch, protectedBranch.count, afterCutCount, row.id,
      ))
    }
    const branchOwner = ownersAfter[0] ?? ownersBefore[0] ?? null
    if (branchOwner && row.branch) {
      console.log(`branch ${row.branch} left because run ${branchOwner.id} records it`)
    }
  })
}

/**
 * Claim a run id, hand the work to a process that outlives this one, and return.
 *
 * The id has to exist BEFORE the agent is picked, because the whole point is to
 * print it and exit — so a placeholder row is claimed here and `run()` fills it
 * in once it has routed. Until then the row reads agent `(pending)`, which is
 * true: nothing has been chosen yet.
 *
 * The child is spawned with no stdio and unref'd, so this process's event loop
 * can drain and exit while the child keeps going. That is the part every
 * caller-side workaround got wrong — a shell wrapper dies and takes the agent
 * with it, and `setsid` does not exist on macOS.
 */
async function detach(jobName: string, prompt: string, spec: DetachSpec): Promise<number> {
  writableDb()
  /**
   * The depth check happens HERE TOO, before a row exists.
   *
   * run() already refuses to delegate from inside a delegated agent, but by
   * then this function has inserted a placeholder row — so a worker that tries
   * to hire someone leaves a `(pending)` row behind that nobody ever fills in
   * and the stale sweep later marks `interrupted`. Observed: a grok worker read
   * the `orch do` instructions in AGENTS.md, tried twice, and left two abandoned
   * rows in the run table.
   *
   * They cost routing nothing, because `(pending)` is not an agent any query
   * groups by — but they are litter in the one table that is supposed to be
   * evidence, and "a run that should not exist should not leave a row behind"
   * is already the rule three lines into run().
   */
  // A retry names the directory the original ran in; everything else is here.
  const cwd = spec.cwd ?? process.cwd()
  // A RESUME skips preflight: its agent was chosen long ago, its worktree
  // exists, and its seed was settled when that worktree was cut. Re-checking
  // would demand a `--seed` for a database that is already there.
  const seed = spec.resume
    ? spec.seed
    : preflight(
        jobName, cwd, spec.seed, spec.key, spec.base, false, false, spec.lens,
        spec.review, spec.carry, spec.repo,
      )
  if (!spec.resume) {
    // Who will run is knowable here, and a proven-failed grok attach must not
    // leave a placeholder for the child to fail. Resume keeps the agent that
    // already started; it is not a new dispatch.
    preflightMcp({
      mcp: spec.mcp, cwd, job: jobName, prompt,
      agent: spec.agent, avoid: spec.avoid,
      distinctModels: spec.distinctModels, model: spec.model, probe: spec.probe,
      lens: spec.lens,
    })
  }
  const runsDir = RUNS_DIR
  mkdirSync(runsDir, { recursive: true })
  // Named by the clock alone, this collided: concurrent `orch do` calls for the
  // same job inside one millisecond wrote the SAME prompt file, and every one of
  // them then read whichever prompt was written last. Six review lenses fired at
  // once produced three runs sharing one file and answering one question. The id
  // is not known until the row below is inserted, so a random suffix carries the
  // uniqueness here; run.ts uses the reserved id once there is one.
  // The repo is known HERE, from the cwd, and was being written as NULL - so
  // every detached run showed a blank project in "running now" until its child
  // got far enough to fill the row in. There is no reason to make the page wait
  // for a fact this function already has.
  // A resume is claimed as a chain member in this same INSERT. Previously the
  // placeholder became visible as a running root and run() attached its parent
  // later, leaving inbox a real window in which the old asking root looked
  // recoverable. One SQLite statement is the claim boundary: readers now see
  // either no new turn or a running turn already linked to its chain.
  const claimed = writeTransaction(() => {
    const projectName = spec.repo ?? repoOf(cwd)
    const projectId = projectName ? projectByName(projectName)?.id ?? null : null
    const inserted = db().query(
      `INSERT INTO run (started_at, agent, job, repo, project_id, cwd, prompt_sha, spec_sha, prompt_bytes,
                      prompt_head, label, status, session_id, probe, parent_run_id, turn, mcp,
                      vendor_session)
       SELECT ?, '(pending)', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?
        WHERE ? IS NULL OR (
          EXISTS (SELECT 1 FROM run root WHERE root.id = ? AND root.status <> 'stale')
          AND NOT EXISTS (
            SELECT 1 FROM run
             WHERE (id = ? OR parent_run_id = ?) AND status = 'running'
          )
        )
       RETURNING id`,
    ).get(
      nowIso(), jobName, projectName, projectId, null,
      createHash('sha256').update(prompt).digest('hex').slice(0, 16),
      createHash('sha256').update(prompt).digest('hex').slice(0, 16),
      prompt.length, prompt.slice(0, 200).replace(/\s+/g, ' '), spec.label ?? null,
      sessionId(), spec.probe ? 1 : 0, spec.resume?.parent ?? null,
      spec.resume?.turn ?? 1, storedMcpRequest(spec.mcp), spec.resume?.session ?? null,
      spec.resume?.parent ?? null, spec.resume?.parent ?? null,
      spec.resume?.parent ?? null, spec.resume?.parent ?? null,
    ) as { id: number } | null
    const deliveryRoot = spec.resume?.parent ?? (spec.retryOf
      ? (db().query('SELECT COALESCE(parent_run_id,id) root_id FROM run WHERE id=?')
          .get(spec.retryOf) as { root_id: number } | null)?.root_id
      : undefined)
    if (inserted && deliveryRoot) {
      db().query(
        `UPDATE question SET delivery_pending_at=NULL
          WHERE delivery_pending_at IS NOT NULL AND run_id IN
            (SELECT id FROM run WHERE id=? OR parent_run_id=?)`,
      ).run(deliveryRoot, deliveryRoot)
    }
    return inserted
  })
  if (!claimed) {
    const root = db().query('SELECT status FROM run WHERE id=?').get(spec.resume!.parent) as
      { status: string } | null
    if (root?.status === 'stale') {
      throw new Error(`run ${spec.resume!.parent} is ${root.status} and cannot be continued`)
    }
    const running = db().query(
      `SELECT id, turn FROM run
        WHERE (id = ? OR parent_run_id = ?) AND status = 'running'
        ORDER BY turn DESC, id DESC LIMIT 1`,
    ).get(spec.resume!.parent, spec.resume!.parent) as { id: number; turn: number }
    throw new Error(
      `run ${spec.resume!.parent} already has running turn ${running.id} (turn ${running.turn})`,
    )
  }
  const { id } = claimed
  // The row now exists, so its id replaces that temporary random name and is
  // also stored on the row for run() to reuse rather than creating a second file.
  const promptPath = runFilePaths(runsDir, Date.now(), id, 'detach', jobName).prompt
  writeFileSync(promptPath, prompt)
  db().query('UPDATE run SET prompt_path=? WHERE id=?').run(promptPath, id)

  /**
   * Spawned into its OWN SESSION, which is the whole point and was missing.
   *
   * `Bun.spawn` has no `detached`, and `unref()` only frees this process's event
   * loop - it does not move the child out of the process group. A harness
   * command timeout does not kill a pid, it kills the GROUP, so the worker died
   * with its caller exactly as the in-process agent had, and detaching bought
   * nothing. Verified the wrong way first: killing the parent PID alone let the
   * run finish, which proved nothing about the case that actually happens.
   * Under `kill -TERM -<pgid>` the run came back `stale`/`interrupted`.
   *
   * node:child_process does have it, and `detached: true` is setsid(2): a new
   * session, a new process group, out of reach of the group kill.
   */
  const execPath = process.env.ORCH_EXEC_PATH ?? process.execPath
  const spawnArgs = [
    /**
     * `exec.ts`, NOT `cli.ts`, and that is the whole point of it.
     *
     * A detached worker is a fresh process that imports this concern's source
     * at spawn time, so an edit anywhere in the graph kills every run launched
     * during it — the child dies on import, before it can fill in the row this
     * function already claimed. Three of another session's runs were lost that
     * way this morning and reported only as "orch was dropping runs".
     *
     * `cli.ts` imports everything statically, so no `try` inside it can catch
     * that. `exec.ts` imports almost nothing and pulls the rest in inside a
     * catch, turning a broken sibling into a recorded failure with a reason.
     */
    new URL('exec.ts', import.meta.url).pathname,
    String(id), promptPath, jobName, JSON.stringify({ ...spec, seed }),
  ]
  const spawnOpts = {
    cwd,
    // The child must not inherit this process's session id: the run row
    // already records the session that ASKED for the work, and run() would
    // otherwise re-stamp it from the child's environment.
    env: { ...process.env, ORCH_DETACHED: '1' },
    stdio: 'ignore' as const,
    detached: true,
  }

  const failSpawn = (err: unknown): never => {
    const why = `spawn failed: ${String((err as Error)?.message ?? err)}`
    db().query(
      `UPDATE run SET status='failed', failure_kind='harness', error=? WHERE id=?`,
    ).run(why, id)
    throw err
  }

  const spawnWorker = (): ChildProcess => {
    try {
      return spawn(execPath, spawnArgs, spawnOpts)
    } catch (err) {
      return failSpawn(err)
    }
  }
  const child = spawnWorker()
  try {
    await new Promise<void>((resolve, reject) => {
      let onError: (err: Error) => void
      let onSpawn: () => void
      onError = (err) => {
        child.off('spawn', onSpawn)
        reject(err)
      }
      onSpawn = () => {
        child.off('error', onError)
        resolve()
      }
      child.once('error', onError)
      child.once('spawn', onSpawn)
    })
  } catch (err) {
    failSpawn(err)
  }

  // The WORKER's pid, recorded now rather than left to run() to overwrite with
  // the agent's. Without one, reapStale skips its liveness check entirely - the
  // check is guarded on `if (r.pid)` - so a worker that dies before it spawns
  // an agent leaves a row claiming to run for the full thirty-minute cutoff.
  // Four such rows were sitting on the dashboard as `(pending)`, one of them
  // for fifteen minutes.
  if (child.pid) db().query('UPDATE run SET pid=? WHERE id=?').run(child.pid, id)
  child.unref()
  return id
}

function refuseEscapedChain(id: number): void {
  const root = db().query('SELECT COALESCE(parent_run_id,id) root_id FROM run WHERE id=?')
    .get(id) as { root_id: number } | null
  const rows = root ? db().query(
    `SELECT id, failure_kind, pre_confinement FROM run
      WHERE (id=? OR parent_run_id=?) AND failure_kind IN ('escaped','confinement_unverified')
      ORDER BY id DESC`,
  ).all(root.root_id, root.root_id) as {
    id: number; failure_kind: string; pre_confinement: string | null
  }[] : []
  if (!rows.length) return
  const kind = rows[0]!.failure_kind
  const recovery = rows.some((row) => !row.pre_confinement)
    ? 'snapshot missing in this chain: clear uses the available snapshots and moves missing outcomes forward'
    : 'snapshots available: clear restores the pre-confinement outcomes'
  throw new Error(
    `run ${id} is ${kind} (${recovery})\n` +
    'invariant: an escaped or confinement-unverified chain is not resumed until the classification is cleared\n' +
    `cleared by: orch confinement clear ${id} --writer TEXT --note TEXT`,
  )
}

/** Resume a root run through the one path shared by `continue` and writing retries. */
async function continueRun(id: number, message?: string): Promise<{ childId: number; job: string }> {
  let authority = authorizeRunMutation(id, 'continue')
  const row = db().query(
    'SELECT id, job, parent_run_id, status FROM run WHERE id = ?',
  ).get(id) as
    { id: number; job: string; parent_run_id: number | null; status: string } | null
  if (!row) throw new Error(`no run ${id}`)
  refuseEscapedChain(id)
  if (row.parent_run_id) {
    throw new Error(`run ${id} is a turn of run ${row.parent_run_id}; continue that one`)
  }
  if (row.status === 'stale') {
    throw new Error(`run ${id} is ${row.status} and cannot be continued`)
  }
  const recordedReview = db().query(
    'SELECT review_id FROM review_lens WHERE run_id=?',
  ).get(row.id) as { review_id: number } | null
  if (recordedReview) {
    throw new Error(
      `run ${id} has a recorded review and cannot be continued\n` +
      "invariant: a recorded review is the run's product and is not re-terminalised\n" +
      'cleared by: dispatch a new review run',
    )
  }
  const running = db().query(
    `SELECT id, turn FROM run
      WHERE (id = ? OR parent_run_id = ?) AND status = 'running'
      ORDER BY turn, id LIMIT 1`,
  ).get(id, id) as { id: number; turn: number } | null
  if (running) {
    throw new Error(`run ${id} already has running turn ${running.id} (turn ${running.turn})`)
  }
  const open = db().query(
    `SELECT COUNT(*) n FROM question q JOIN run r ON r.id = q.run_id
      WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL`,
  ).get(id, id) as { n: number }
  // A worker waiting on a ruling must be RULED ON, not talked past. Continuing
  // one would resume it with its question unanswered, and a worker resumed
  // with an open question guesses — the single thing this design exists to
  // prevent.
  if (open.n) throw new Error(`run ${id} is waiting on ${open.n} question(s): orch answer ${id} ...`)
  const latest = db().query(
    `SELECT id, agent, vendor_session, turn, cwd, worktree, branch, base_commit, worktree_source
       FROM run WHERE id = ? OR parent_run_id = ?
      ORDER BY turn DESC LIMIT 1`,
  ).get(id, id) as {
    id: number; agent: string; vendor_session: string | null; turn: number
    cwd: string | null; worktree: string | null; branch: string | null; base_commit: string | null
    worktree_source: Worktree['source'] | null
  }
  const checkpointContext = (await import('./checkpoint.ts'))
    .checkpointResumeContext(db(), id, latest.worktree)
  const sessionFrom = checkpointContext ? null : latest.vendor_session
    ? latest
    : db().query(
        `SELECT id, agent, vendor_session, turn
           FROM run WHERE (id = ? OR parent_run_id = ?) AND vendor_session IS NOT NULL
          ORDER BY turn DESC LIMIT 1`,
      ).get(id, id) as { id: number; agent: string; vendor_session: string; turn: number } | null
  if (!checkpointContext && !sessionFrom?.vendor_session) {
    throw new Error(`run ${id} recorded no session id, so ${latest.agent} cannot be resumed`)
  }
  if (!checkpointContext && !latest.vendor_session) {
    console.error(
      `run ${id}: newest turn ${latest.id} recorded no session id; ` +
      `resuming ${sessionFrom!.agent} with the session from run ${sessionFrom!.id} (turn ${sessionFrom!.turn})`,
    )
  }
  let prompt: string
  if (checkpointContext) {
    const rootPrompt = db().query('SELECT prompt_path FROM run WHERE id=?').get(id) as
      { prompt_path: string | null }
    if (!rootPrompt.prompt_path || !existsSync(rootPrompt.prompt_path)) {
      throw new Error(`run ${id} checkpoint cannot continue: its original prompt file is unavailable`)
    }
    prompt = [checkpointContext, readFileSync(rootPrompt.prompt_path, 'utf8'), message]
      .filter((part): part is string => Boolean(part)).join('\n\n')
  } else {
    prompt = message
      ?? 'Continue from where you stopped and finish the spec. If you reached a ' +
         'decision that is not yours, stop and ask as before.'
  }
  const assembledLimit = checkpointContext ? undefined : argvResumeLimit(sessionFrom!.agent)
  if (assembledLimit !== undefined) {
    const packed = packedResumePrompt(row.job, prompt, id)
    const assembled = Buffer.byteLength(packed, 'utf8')
    if (assembled > assembledLimit) {
      throw new Error(
        `assembled resume prompt is ${assembled} bytes; this agent's resume transport is bounded at ${assembledLimit} bytes\n` +
        `nothing was stored\nworking forms:\n${CONTINUE_WORKING_FORMS}`,
      )
    }
  }
  const launch = db().query(
    `SELECT launch_cwd, launch_seed, launch_key, launch_base, no_failover, mcp, mcp_error, lens
       FROM run WHERE id=?`,
  ).get(id) as {
    launch_cwd: string | null; launch_seed: string | null; launch_key: string | null
    launch_base: string | null; no_failover: number; mcp: number | null; mcp_error: string | null
    lens: string | null
  }
  authority = writeTransaction(() => {
    const adopted = adoptRunMutation(authority, 'continue')
    // Stop preserves the artifact specifically so this transition can reopen it.
    db().query("UPDATE run SET status='failed' WHERE id=? AND status='stopped'").run(id)
    return adopted
  })
  const childId = await detach(row.job, prompt, {
    cwd: latest.cwd ?? process.cwd(),
    seed: launch.launch_seed ?? undefined,
    key: launch.launch_key ?? undefined,
    base: launch.launch_base ?? undefined,
    noFailover: !!launch.no_failover,
    mcp: mcpRequestFromStored(launch.mcp, launch.mcp_error),
    lens: launch.lens ?? undefined,
    transport: chainTransport(id) ?? undefined,
    resume: {
      parent: id, agent: checkpointContext ? latest.agent : sessionFrom!.agent,
      session: checkpointContext ? undefined : sessionFrom!.vendor_session ?? undefined,
      fresh: Boolean(checkpointContext),
      turn: latest.turn + 1, sessionId: authority.owner,
      worktree: latest.worktree
        ? {
            path: latest.worktree,
            branch: latest.branch ?? '',
            base: latest.base_commit ?? '',
            repoRoot: (await import('./worktree.ts')).repoRootOf(latest.worktree) ?? process.cwd(),
            source: latest.worktree_source ?? undefined,
          }
        : null,
    },
  })
  auditRunMutation(authority, 'continue', message ?? null)
  return { childId, job: row.job }
}

async function reportContinuedRun(childId: number, jobName: string): Promise<void> {
  if (has('detach') || !has('follow')) {
    printRunId(childId)
    if (!has('quiet')) {
      console.error(
        `\n— ${jobName} runs detached; a foreground one dies with its shell.` +
        `\n  orch wait ${childId}      then:  orch result ${childId}` +
        `\n  orch inbox          if it stops to ask` +
        `\n  --follow            to watch it here instead`,
      )
    }
    return
  }
  await follow(childId, has('quiet'))
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
      --base <ref>              ${baseHelp('base an implement, fix or land worktree on this git commit')}
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
  orch land <branch|run-id>     enqueue a landing; a per-project queue owns rebase, gate, fast-forward and migrate
      --wait                    block until this landing terminals (default is enqueue and return)
      --message TEXT            amend the branch tip's message, then gate that commit
      --file PATH               same, reading the message from a file
      --unreviewed REASON       land without matching review coverage and record why
      --strand-live REASON      land a journal-carrying diff while runs are live, naming why
      --status                  print queued and in-review branches, path sets, and locks
      --drain                   process the project's queue until empty (started by enqueue when needed)
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
  orch abandon <id> [--note "..."] [--force] retire an asking run and clean up its worktree
  orch sweep [--force] [--dry-run]
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
  --base <ref>     ${baseHelp('base an implement, fix or land worktree on this verified git commit')}
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
  if (commandFile) return readWorkerFile(commandFile)
  if (positional.length) return positional.join(' ')
  if (!process.stdin.isTTY) {
    return decodeWorkerBytes(new Uint8Array(await Bun.stdin.bytes()), 'stdin')
  }
  if (opts.optional) return undefined
  throw new Error(opts.missing)
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

  case 'land': {
    const { drainQueue, land, landingStatus, resolveLandingBranch } = await import('./landing.ts')
    if (has('status')) {
      console.log(landingStatus(process.cwd()))
      break
    }
    if (has('drain')) {
      drainQueue(process.cwd())
      break
    }
    const value = argv[1]
    if (!value || value.startsWith('--')) {
      throw new Error('orch land <branch|run-id> [--message TEXT] [--file PATH] [--unreviewed REASON] [--keep-checkpoints] [--wait] | orch land --status')
    }
    const fromMessage = flag('message')
    const fromFile = flag('file')
    if (fromMessage !== undefined && fromFile !== undefined) {
      throw new Error(
        'pass --message or --file, not both\nworking form: orch land <branch|run-id> [--message TEXT] [--file PATH]',
      )
    }
    const message = fromFile !== undefined ? readFileSync(fromFile, 'utf8') : fromMessage
    const target = resolveLandingBranch(value)
    if (target.runId !== null) console.log(`run ${target.runId} resolves to branch ${target.branch}`)
    const unreviewed = flag('unreviewed')
    const strandLive = flag('strand-live')
    if (unreviewed !== undefined && !unreviewed.trim()) {
      throw new Error('--unreviewed requires a non-empty reason')
    }
    if (strandLive !== undefined && !strandLive.trim()) {
      throw new Error('--strand-live requires a non-empty reason')
    }
    const result = land(process.cwd(), target.branch, {
      ...(target.runId === null ? {} : { runId: target.runId }),
      ...(message === undefined ? {} : { message }),
      ...(unreviewed === undefined ? {} : { unreviewed }),
      ...(strandLive === undefined ? {} : { strandLive }),
      keepCheckpoints: has('keep-checkpoints'),
      wait: has('wait'),
    })
    if (result) console.log(result)
    break
  }

  case 'reconcile': {
    const { reconcileRun } = await import('./run.ts')
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
    await loadWorktree()
    const { parseConfinement } = await import('./confinement.ts')
    let authority = authorizeRunMutation(id, 'reclassify')
    const rows = db().query(
      `SELECT id, failure_kind, error, pre_confinement, confinement FROM run
        WHERE (id=? OR parent_run_id=?)
          AND failure_kind IN ('escaped','confinement_unverified') ORDER BY turn,id`,
    ).all(authority.rootId, authority.rootId) as {
      id: number; failure_kind: string; error: string | null
      pre_confinement: string | null; confinement: string | null
    }[]
    if (!rows.length) throw new Error(`run ${id}'s chain has no confinement classification to clear`)
    const chain = db().query(
      `SELECT repo, worktree, branch, head_commit, input_tree FROM run
        WHERE id=? OR parent_run_id=? ORDER BY turn DESC,id DESC`,
    ).all(authority.rootId, authority.rootId) as {
      repo: string | null; worktree: string | null; branch: string | null
      head_commit: string | null; input_tree: string | null
    }[]
    const recorded = <K extends keyof typeof chain[number]>(key: K) =>
      chain.find((row) => row[key] !== null)?.[key] ?? null
    const repo = recorded('repo')
    const worktree = recorded('worktree')
    const branch = recorded('branch')
    const recordedTip = recorded('head_commit')
    const recordedTree = recorded('input_tree')
    if (!repo || !worktree || !branch || !recordedTip || !recordedTree) {
      throw new Error(`run ${id}'s chain lacks a recorded repository, worktree, branch tip, or measured tree`)
    }
    const project = projectByName(repo)
    if (!project) throw new Error(`run ${id}'s recorded project ${repo} is not registered`)
    const inspect = (cwd: string, args: string[]) => {
      const child = Bun.spawnSync(['git', ...args], {
        cwd, env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'pipe',
      })
      return child.exitCode === 0 ? child.stdout.toString().trim() : null
    }
    const currentTip = inspect(project.path, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
    if (!currentTip) throw new Error(`recorded branch ${branch} no longer exists in ${project.path}`)
    const worktreeMissing = !existsSync(worktree)
    const currentTree = worktreeMissing
      ? inspect(project.path, ['rev-parse', '--verify', `${currentTip}^{tree}`])
      : contentTree(worktree)
    const suppliedTip = flag('tip')?.trim() ?? null
    const snapshotted = rows.map((row) => parseConfinement(row.confinement))
      .find((value) => value?.tripTip || value?.chainRoot)
    const divergence = currentTip !== recordedTip
    const recoveryCommand = `git worktree add ${worktree} ${branch}`
    const audit = {
      writer, note, recordedTip, currentTip, recordedTree, currentTree,
      worktree, branch, divergence, suppliedTip, cleared: false,
      tripTip: snapshotted?.tripTip ?? null, chainRoot: snapshotted?.chainRoot ?? null,
    }
    const auditOnly = () => writeTransaction(() => {
      authority = adoptRunMutation(authority, 'receipt')
      auditRunMutation(authority, 'reclassify', JSON.stringify(audit))
    })
    if (divergence && !suppliedTip && !snapshotted?.tripTip && !snapshotted?.chainRoot) {
      auditOnly()
      throw new Error(
        `refusing to clear confinement: ${branch} moved from recorded tip ${recordedTip} to ${currentTip}; ` +
        `pass --tip ${currentTip} to acknowledge the current artifact`,
      )
    }
    if (suppliedTip && suppliedTip !== currentTip) {
      auditOnly()
      throw new Error(`refusing --tip ${suppliedTip}: ${branch}'s current tip is ${currentTip}`)
    }
    const transitions = rows.map((row) => {
      const mode = row.pre_confinement ? 'restored' : 'forward'
      const value = (row.pre_confinement ? JSON.parse(row.pre_confinement) : {
        status: 'failed', failureKind: null,
        error: `confinement cleared forward by ${writer}: ${note}; pre-confinement outcome unavailable`,
      }) as {
        status?: string; failureKind?: string | null; error?: string | null
        landingBlock?: { detail: string; invariant: string; command: string; worktree: string } | null
        clearMode?: 'restored' | 'forward'
      }
      if (!['ok', 'failed', 'asking', 'stopped', 'stale'].includes(value.status ?? '')) {
        throw new Error(`run ${row.id} has invalid pre-confinement status`)
      }
      if (worktreeMissing) {
        value.landingBlock = {
          detail: `recorded worktree ${worktree} is missing for branch ${branch}`,
          invariant: 'A cleared confinement chain needs its recorded worktree before landing.',
          command: recoveryCommand,
          worktree,
        }
      } else delete value.landingBlock
      value.clearMode = mode
      return { row, value, mode }
    })
    writeTransaction(() => {
      authority = adoptRunMutation(authority, 'receipt')
      const current = db().query(
        `SELECT id FROM run WHERE (id=? OR parent_run_id=?)
          AND failure_kind IN ('escaped','confinement_unverified') ORDER BY turn,id`,
      ).all(authority.rootId, authority.rootId) as { id: number }[]
      if (current.length !== rows.length || current.some(({ id }, index) => id !== rows[index]!.id)) {
        throw new Error(`run ${id}'s confinement classification changed before it could be cleared`)
      }
      const update = db().query(
        `UPDATE run SET status=?, failure_kind=?, error=?, pre_confinement=? WHERE id=?
          AND failure_kind IN ('escaped','confinement_unverified')`,
      )
      for (const { row, value } of transitions) {
        const changed = update.run(
          value.status!, value.failureKind ?? null, value.error ?? null, JSON.stringify(value), row.id,
        )
        if (changed.changes !== 1) {
          throw new Error(`run ${row.id}'s confinement classification changed before it could be cleared`)
        }
      }
      resolveRootFromLastTurn(db(), authority.rootId)
      auditRunMutation(authority, 'reclassify', JSON.stringify({ ...audit, cleared: true,
        transitions: transitions.map(({ row, mode }) => ({ runId: row.id, mode })),
        priorOutcomes: rows.map((row) => ({
          runId: row.id, failureKind: row.failure_kind, error: row.error,
        })),
        landingBlock: worktreeMissing ? recoveryCommand : null }))
    })
    console.log(
      `cleared confinement for chain ${authority.rootId}; ruling by ${writer}: ${note}`,
    )
    if (worktreeMissing) {
      console.log(
        `landing remains blocked: recorded worktree ${worktree} is missing\n` +
        `invariant: A cleared confinement chain needs its recorded worktree before landing.\n` +
        `cleared by: ${recoveryCommand}`,
      )
    }
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
    const { listDocs, getDoc, setDoc, consumeDoc, removeDoc, exportDocs, importDocs, brief, docSubjects,
            listOpenResumes, listDocRevisions, diffDocRevisions, restoreDoc } =
      await import('./docs.ts')
    const sub = argv[1] ?? 'list'
    const scope = flag('scope')
    const subject = flag('subject') ?? null
    if (sub === 'list') {
      const rows = listDocs({ scope, ...(has('subject') ? { subject } : {}) })
      if (has('json')) { console.log(JSON.stringify(rows)); break }
      if (!rows.length) break
      console.log('scope    subject          slug                     title                    delivery  bytes  updated')
      for (const d of rows) {
        console.log(
          `${d.scope.padEnd(8)} ${(d.subject ?? '-').padEnd(16)} ${d.slug.padEnd(24)} ` +
          `${d.title.padEnd(24)} ${d.delivery.padEnd(8)} ${String(Buffer.byteLength(d.body)).padStart(6)}  ${d.updated_at}`,
        )
      }
      break
    }
    if (sub === 'show') {
      const slug = argv[2]
      if (!slug || !scope) throw new Error('orch doc show <slug> --scope S [--subject X]')
      const doc = getDoc(scope, subject, slug)
      if (!doc) throw new Error(`no ${scope} doc "${slug}"; use orch doc list --scope ${scope}`)
      if (has('json')) { console.log(JSON.stringify(doc)); break }
      process.stdout.write(doc.body)
      break
    }
    if (sub === 'set') {
      const slug = argv[2]
      const title = flag('title')
      const reason = flag('reason')
      if (!slug || !scope || title === undefined || !reason?.trim()) {
        throw new Error('orch doc set <slug> --scope S [--subject X] --title T --reason TEXT (--file F | body on stdin)')
      }
      const body = flag('file') ? readFileSync(flag('file')!, 'utf8')
        : !process.stdin.isTTY ? await Bun.stdin.text()
        : (() => { throw new Error('no body: pass --file F or pipe markdown on stdin') })()
      const delivery = flag('delivery')
      if (delivery !== undefined && delivery !== 'inject' && delivery !== 'demand') {
        throw new Error('--delivery must be inject or demand')
      }
      const forceInject = flag('force-inject')
      if (has('force-inject') && !forceInject?.trim()) throw new Error('--force-inject requires a non-empty reason')
      const doc = setDoc({ scope, subject, slug, title, body, reason, author: flag('author'), forceInject,
        delivery: delivery as 'inject' | 'demand' | undefined })
      const { checkDoc, repoRootForDoc } = await import('./canon.ts')
      const root = repoRootForDoc(doc)
      const warnings = root ? checkDoc(body, { repoRoot: root }) : []
      if (has('json')) console.log(JSON.stringify({ ...doc, warnings }))
      else {
        console.log(`set ${doc.scope}/${doc.subject ?? '_'}/${doc.slug}`)
        for (const warning of warnings) console.error(`warning: ${warning.message}`)
      }
      break
    }
    if (sub === 'consume') {
      const slug = argv[2]
      if (!slug || !scope) throw new Error('orch doc consume <slug> --scope S [--subject X]')
      const result = consumeDoc(scope, subject, slug, {
        reason: flag('reason') ?? 'consumed by session', author: flag('author'),
      })
      if (has('json')) { console.log(JSON.stringify(result)); break }
      console.log(result.already_consumed
        ? `already consumed ${result.scope}/${result.subject ?? '_'}/${result.slug}`
        : `consumed ${result.scope}/${result.subject ?? '_'}/${result.slug}`)
      break
    }
    if (sub === 'rm') {
      const slug = argv[2]
      const reason = flag('reason')
      if (!slug || !scope || !reason?.trim()) throw new Error('orch doc rm <slug> --scope S [--subject X] --reason TEXT')
      const removed = removeDoc(scope, subject, slug, { reason, author: flag('author') })
      if (has('json')) { console.log(JSON.stringify({ removed })); break }
      console.log(removed ? `removed ${scope}/${subject ?? '_'}/${slug}` : `no ${scope} doc "${slug}"`)
      break
    }
    if (sub === 'subjects') {
      const subjects = docSubjects()
      if (has('json')) { console.log(JSON.stringify(subjects)); break }
      for (const [name, names] of Object.entries(subjects)) {
        console.log(`${name.padEnd(8)} ${names.join(', ') || '(none)'}`)
      }
      break
    }
    if (sub === 'export' || sub === 'import') {
      const dir = argv[2]
      if (!dir) throw new Error(`orch doc ${sub} <dir>`)
      const reason = flag('reason')
      if (sub === 'import' && !reason?.trim()) throw new Error('orch doc import <dir> --reason TEXT [--author NAME]')
      const count = sub === 'export' ? exportDocs(dir) : importDocs(dir, { reason: reason!, author: flag('author') })
      console.log(`${sub === 'export' ? 'exported' : 'imported'} ${count} docs`)
      break
    }
    if (sub === 'history' || sub === 'diff' || sub === 'restore') {
      const addressScope = argv[2]
      const addressSubject = argv[3] === '-' ? null : argv[3]
      const slug = argv[4]
      if (!addressScope || argv[3] === undefined || !slug) {
        throw new Error(`orch doc ${sub} <scope> <subject|-> <slug>${sub === 'restore' ? ' <rev> --reason TEXT' : ''}`)
      }
      const revisions = listDocRevisions(addressScope, addressSubject, slug)
      if (sub === 'history') {
        if (has('json')) console.log(JSON.stringify(revisions))
        else for (const revision of revisions) {
          console.log(`${revision.id}  ${revision.op.padEnd(8)} ${revision.author}  ${revision.at}  ${revision.bytes} bytes  ${revision.reason}`)
        }
        break
      }
      if (sub === 'diff') {
        const a = argv[5] ? Number(argv[5]) : revisions[1]?.id
        const b = argv[6] ? Number(argv[6]) : revisions[0]?.id
        if (!a || !b) throw new Error('doc diff needs two revisions; this address has fewer than two')
        const addressIds = new Set(revisions.map((revision) => revision.id))
        if (!addressIds.has(a) || !addressIds.has(b)) {
          throw new Error(`doc diff revisions must belong to ${addressScope}/${addressSubject ?? '_'}/${slug}`)
        }
        process.stdout.write(diffDocRevisions(a, b))
        break
      }
      const revisionId = Number(argv[5])
      const reason = flag('reason')
      if (!revisionId || !reason?.trim()) {
        throw new Error('orch doc restore <scope> <subject|-> <slug> <rev> --reason TEXT')
      }
      const restored = restoreDoc(addressScope, addressSubject, slug, revisionId, {
        reason, author: flag('author'),
      })
      console.log(has('json') ? JSON.stringify(restored) : `restored ${addressScope}/${addressSubject ?? '_'}/${slug}`)
      break
    }
    if (sub === 'brief') {
      process.stdout.write(brief(flag('cwd') ?? process.cwd()))
      break
    }
    if (sub === 'resumes') {
      const result = listOpenResumes(flag('cwd') ?? process.cwd())
      if (has('json')) {
        console.log(JSON.stringify(result))
        break
      }
      for (const r of result.open) {
        console.log(`${r.slug.padEnd(24)} ${r.title.padEnd(24)} ${r.age}`)
      }
      for (const r of result.unreadable) {
        console.error(`unreadable resume brief ${r.slug}: ${r.reason}`)
      }
      break
    }
    throw new Error(`unknown: orch doc ${sub}. Try list | show | set | consume | rm | history | diff | restore | subjects | export | import | brief | resumes`)
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
    const {
      addDoctrineRule, addPair, addSkip, baselineForPair, ledgerRef, listDoctrineRules,
      listLedgerRefs, listSkips, pairByProjects, removeLedgerRef, resolveLedgerRef,
      retireDoctrineRule, setBaseline, setLedgerRef,
    } = await import('./porting.ts')
    const group = argv[1]
    const action = argv[2]
    const namedProject = (name: string) => {
      const project = projectByName(name)
      if (!project) throw new Error(`unknown project "${name}". Registered: ${projectNames()}`)
      return project
    }
    const namedPair = (sourceName: string, targetName: string, create = false) => {
      const source = namedProject(sourceName)
      const target = namedProject(targetName)
      if (source.id === target.id) throw new Error('a port source and target must be different projects')
      const pair = pairByProjects(source.id, target.id) ?? (create ? addPair(source.id, target.id) : null)
      return { pair, source, target }
    }
    const output = (value: unknown, line: string) =>
      console.log(has('json') ? JSON.stringify(value) : line)

    if (group === 'import') {
      const dir = argv[2]
      if (!dir) throw new Error('orch port import <dir> [--dry-run] [--replace] [--json]')
      const { applyImport, ImportRefusalError, planImport, projectsForDryRun, sourceCoverage } =
        await import('./porting-import.ts')
      const names = {
        doctrine: 'doctrine.md', differences: 'differences.md', backports: 'backports.md',
        refs: 'refs.json', state: 'state.json', projects: 'projects.md',
      } as const
      const files = {} as Record<keyof typeof names, string>
      const ioRefusals: { kind: 'refusal'; what: string; where: string; why: string }[] = []
      try {
        if (!statSync(dir).isDirectory()) throw new Error('not a directory')
        readdirSync(dir)
      } catch (error) {
        ioRefusals.push({ kind: 'refusal', what: 'source directory', where: dir, why: String(error) })
      }
      for (const [key, name] of Object.entries(names) as [keyof typeof names, string][]) {
        const path = join(dir, name)
        try { files[key] = readFileSync(path, 'utf8') }
        catch (error) {
          files[key] = ''
          ioRefusals.push({ kind: 'refusal', what: `source file "${name}"`, where: path, why: String(error) })
        }
      }
      let plan
      if (ioRefusals.length) {
        plan = {
          pairs: [], baselines: [], skips: [], refs: [], doctrine: [], docs: [],
          refusals: ioRefusals, exclusions: [],
        }
      } else {
        let registered: ReturnType<typeof projects>
        try { registered = has('dry-run') ? projectsForDryRun(DB_PATH) : projects() }
        catch (error) {
          ioRefusals.push({ kind: 'refusal', what: 'project register', where: DB_PATH, why: String(error) })
          registered = []
        }
        plan = ioRefusals.length
          ? { pairs: [], baselines: [], skips: [], refs: [], doctrine: [], docs: [],
              refusals: ioRefusals, exclusions: [] }
          : planImport(files, registered)
      }
      const visiblePlan = () => {
        const uncoveredSpans = sourceCoverage(plan, files)
        return {
          ...plan,
          doctrine: plan.doctrine.map((row) => ({ ...row, bodyLength: row.body.length })),
          docs: plan.docs.map((row) => ({ ...row, bodyLength: row.body.length })),
          uncoveredSpans,
        }
      }
      const printPlan = async () => {
        const visible = visiblePlan()
        const uncoveredSpans = visible.uncoveredSpans
        if (has('json')) { await writeStdout(`${JSON.stringify(visible, null, 2)}\n`); return }
        console.log(`pairs (${plan.pairs.length})`)
        for (const row of plan.pairs) console.log(`  ${row.source} -> ${row.target}  ids ${row.sourceId}->${row.targetId}`)
        console.log(`baselines (${plan.baselines.length})`)
        for (const row of plan.baselines) console.log(`  ${row.pairKey}  ${row.sourceCommit ?? 'null'}  ${row.scannedAt ?? 'null'}`)
        console.log(`skips (${plan.skips.length})`)
        for (const row of plan.skips) console.log(`  ${row.pairKey}  ${row.candidate}  reason=${row.reason}`)
        console.log(`refs (${plan.refs.length})`)
        for (const row of plan.refs) {
          console.log(`  ${row.taskKey}  note=${JSON.stringify(row.note)}`)
          for (const source of row.sources) {
            console.log(`    source_project_id=${source.source_project_id} commits=${JSON.stringify(source.commits)} paths=${JSON.stringify(source.paths)} note=${JSON.stringify(source.note)}`)
          }
        }
        console.log(`doctrine (${plan.doctrine.length})`)
        for (const row of plan.doctrine) console.log(`  ${row.number}  ${row.title}  body length=${row.body.length}`)
        console.log(`docs (${plan.docs.length})`)
        for (const row of plan.docs) {
          console.log(`  ${row.scope}/${row.subject ?? '_'}/${row.slug}  ${row.title}  body length=${row.body.length}`)
        }
        console.log(`refusals (${plan.refusals.length})`)
        for (const refusal of plan.refusals) {
          console.log(`  ${refusal.what} / ${refusal.where} / ${refusal.why}`)
        }
        console.log(`exclusions (${plan.exclusions.length})`)
        for (const exclusion of plan.exclusions) {
          console.log(`  ${exclusion.what} / ${exclusion.where} / ${exclusion.why}`)
          if (exclusion.value !== undefined) console.log(`    original value: ${exclusion.value}`)
        }
        console.log(`uncovered spans (${uncoveredSpans.length})`)
        for (const span of uncoveredSpans) {
          console.log(`  ${span.file} offset ${span.offset} / ${JSON.stringify(span.text)}`)
        }
      }
      if (has('dry-run')) {
        await printPlan()
        if (plan.refusals.length) process.exitCode = 1
        break
      }
      try {
        applyImport(plan, { replace: has('replace'), sourceLabel: dir })
      } catch (error) {
        if (!(error instanceof ImportRefusalError)) throw error
        plan.refusals.push(...error.refusals.filter((refusal) => !plan.refusals.includes(refusal)))
        await printPlan()
        process.exitCode = 1
        break
      }
      if (has('json')) console.log(JSON.stringify(visiblePlan(), null, 2))
      else console.log(`imported ${plan.pairs.length} pairs, ${plan.refs.length} refs, ${plan.doctrine.length} doctrine rules, and ${plan.docs.length} docs`)
      break
    }

    if (group === 'baseline' && action === 'show') {
      const sourceName = argv[3]
      const targetName = argv[4]
      if (!sourceName || !targetName) throw new Error('orch port baseline show <source> <target> [--json]')
      const { pair } = namedPair(sourceName, targetName)
      if (!pair) {
        output(null, `no port pair from "${sourceName}" to "${targetName}"`)
        break
      }
      const value = { pair, baseline: baselineForPair(pair.id) }
      output(value, value.baseline?.source_commit
        ? `${sourceName} -> ${targetName}  ${value.baseline.source_commit}  ${value.baseline.scanned_at}`
        : `${sourceName} -> ${targetName}  no baseline`)
      break
    }

    if (group === 'baseline' && action === 'set') {
      const sourceName = argv[3]
      const targetName = argv[4]
      const commit = has('clear') ? null : argv[5]
      if (!sourceName || !targetName || (!has('clear') && !commit)) {
        throw new Error('orch port baseline set <source> <target> <commit> [--json] | --clear')
      }
      const { pair } = namedPair(sourceName, targetName, true)
      const baseline = setBaseline(pair!.id, commit)
      output({ pair, baseline }, commit
        ? `set ${sourceName} -> ${targetName} baseline to ${commit}`
        : `cleared ${sourceName} -> ${targetName} baseline`)
      break
    }

    if (group === 'skip' && action === 'list') {
      const sourceName = argv[3]
      const targetName = argv[4]
      if (!sourceName || !targetName) throw new Error('orch port skip list <source> <target> [--json]')
      const { pair } = namedPair(sourceName, targetName)
      const rows = pair ? listSkips(pair.id) : []
      if (has('json')) { console.log(JSON.stringify(rows)); break }
      for (const row of rows) console.log(`${row.candidate}  ${row.reason}  ${row.skipped_at}`)
      break
    }

    if (group === 'skip' && action === 'add') {
      const sourceName = argv[3]
      const targetName = argv[4]
      const candidate = argv[5]
      const reason = flag('reason')
      if (!sourceName || !targetName || !candidate || reason === undefined) {
        throw new Error('orch port skip add <source> <target> <candidate> --reason TEXT [--json]')
      }
      const { pair } = namedPair(sourceName, targetName)
      if (!pair) throw new Error(`no port pair from "${sourceName}" to "${targetName}"; set its baseline first`)
      const row = addSkip(pair.id, candidate, reason)
      output(row, `skipped ${candidate}: ${reason}`)
      break
    }

    if (group === 'ref' && action === 'list') {
      const rows = listLedgerRefs(has('all'))
      if (has('json')) { console.log(JSON.stringify(rows)); break }
      for (const row of rows) {
        console.log(`${row.task_key}  ${row.sources.length} source(s)  ${row.resolved_at ?? 'unresolved'}  ${row.note}`)
      }
      break
    }

    if (group === 'ref' && action === 'show') {
      const taskKey = argv[3]
      if (!taskKey) throw new Error('orch port ref show <task-key> [--json]')
      const ref = ledgerRef(taskKey)
      if (!ref) throw new Error(`no port ledger ref for task "${taskKey}"`)
      if (has('json')) { console.log(JSON.stringify(ref)); break }
      console.log(`${ref.task_key}  ${ref.resolved_at ?? 'unresolved'}\n${ref.note}`)
      for (const source of ref.sources) {
        const project = projects().find((candidate) => candidate.id === source.source_project_id)
        if (!project) throw new Error(`ledger ref ${taskKey} names unregistered project id ${source.source_project_id}`)
        console.log(`  ${project.name}  commits=${source.commits.join(',')}  paths=${source.paths.join(',')}  ${source.note}`)
      }
      break
    }

    if (group === 'ref' && action === 'set') {
      const taskKey = argv[3]
      const sourceJson = flag('sources')
      const note = flag('note')
      if (!taskKey || sourceJson === undefined || note === undefined) {
        throw new Error('orch port ref set <task-key> --sources JSON --note TEXT [--json]')
      }
      let raw: unknown
      try { raw = JSON.parse(sourceJson) } catch (error) {
        throw new Error(`--sources must be JSON: ${error}`)
      }
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('--sources must be a non-empty JSON array')
      }
      const sources = raw.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error(`--sources[${index}] must be an object`)
        }
        const source = value as Record<string, unknown>
        if (typeof source.project !== 'string' || !Array.isArray(source.commits) ||
            !source.commits.every((item) => typeof item === 'string') ||
            !Array.isArray(source.paths) || !source.paths.every((item) => typeof item === 'string') ||
            typeof source.note !== 'string') {
          throw new Error(`--sources[${index}] needs project, string-array commits, string-array paths, and note`)
        }
        return {
          source_project_id: namedProject(source.project).id,
          commits: source.commits as string[], paths: source.paths as string[], note: source.note,
        }
      })
      const ref = setLedgerRef({ taskKey, note, sources })
      output(ref, `recorded provenance for ${taskKey} from ${sources.length} source project(s)`)
      break
    }

    if (group === 'ref' && action === 'resolve') {
      const taskKey = argv[3]
      if (!taskKey) throw new Error('orch port ref resolve <task-key> [--json]')
      const ref = resolveLedgerRef(taskKey)
      if (!ref) throw new Error(`no port ledger ref for task "${taskKey}"`)
      output(ref, `resolved ${taskKey} at ${ref.resolved_at}`)
      break
    }

    if (group === 'ref' && action === 'delete-error') {
      const taskKey = argv[3]
      if (!taskKey) throw new Error('orch port ref delete-error <task-key> [--json]')
      const removed = removeLedgerRef(taskKey)
      output({ removed }, removed
        ? `permanently deleted erroneous ledger ref ${taskKey}`
        : `no port ledger ref for task "${taskKey}"`)
      break
    }

    if (group === 'doctrine' && action === 'list') {
      const rows = listDoctrineRules(has('all'))
      if (has('json')) { console.log(JSON.stringify(rows)); break }
      for (const row of rows) {
        console.log(`${String(row.number).padStart(3)}  ${row.retired_at ? `retired ${row.retired_at}` : 'active'}  ${row.title}`)
      }
      break
    }

    if (group === 'doctrine' && action === 'add') {
      const number = Number(argv[3])
      const title = flag('title')
      if (!Number.isInteger(number) || number <= 0 || title === undefined) {
        throw new Error('orch port doctrine add <number> --title TEXT (--file F | body on stdin) [--json]')
      }
      const body = flag('file') ? readFileSync(flag('file')!, 'utf8')
        : !process.stdin.isTTY ? await Bun.stdin.text()
        : (() => { throw new Error('no body: pass --file F or pipe text on stdin') })()
      const rule = addDoctrineRule(number, title, body)
      output(rule, `added doctrine ${number}: ${title}`)
      break
    }

    if (group === 'doctrine' && action === 'retire') {
      const number = Number(argv[3])
      if (!Number.isInteger(number) || number <= 0) {
        throw new Error('orch port doctrine retire <number> [--json]')
      }
      const retired = retireDoctrineRule(number)
      output({ retired }, retired ? `retired doctrine ${number}` : `no active doctrine ${number}`)
      break
    }

    const portVerbs: Record<string, string> = {
      baseline: 'show | set',
      skip: 'list | add',
      ref: 'list | show | set | resolve | delete-error',
      doctrine: 'list | add | retire',
    }
    if (group && portVerbs[group]) {
      throw new Error(`unknown: orch port ${group}${action ? ` ${action}` : ''}. Try ${portVerbs[group]}`)
    }
    throw new Error('unknown: orch port. Try import | baseline | skip | ref | doctrine')
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
      if (jobName !== 'implement' && jobName !== 'fix' && jobName !== 'land') {
        throw new Error('--base is only valid for the implement, fix and land jobs')
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
    await Promise.all([loadJobs(), loadWorktree(), loadReview(), loadReviewTier()])
    const sub = argv[1]
    if (sub === '--help' || sub === '-h') reviewUsage()
    if (sub === 'list') {
      if (has('open') && has('complete')) throw new Error('--open and --complete are mutually exclusive')
      const since = flag('since')
      if (since && !z.iso.datetime().safeParse(since).success) {
        throw new Error('--since must be an ISO datetime (for example 2026-01-01T00:00:00Z)')
      }
      const rows = listReviews({
        state: has('open') ? 'open' : has('complete') ? 'complete' : undefined,
        project: flag('project'), since,
      })
      if (has('json')) console.log(JSON.stringify(rows))
      else if (!rows.length) console.log('no reviews')
      else {
        console.log('id  recorded_at               completed  project  branches  tier/risk/size  lenses  findings t/tr/a/m/r/s  coverage')
        for (const row of rows) console.log(
          `${String(row.id).padEnd(3)} ${row.recorded_at.padEnd(25)} ${row.completed_at ? 'yes' : 'no '}        ` +
          `${(row.project ?? '—').padEnd(8)} ${(row.branches.join(',') || '—').padEnd(9)} ` +
          `${`${row.tier ?? '—'}/${row.risk ?? '—'}/${row.size ?? '—'}`.padEnd(14)} ${String(row.lens_count).padEnd(7)} ` +
          `${row.findings.total}/${row.findings.triaged}/${row.findings.accepted}/${row.findings.modified}/${row.findings.rejected}/${row.findings.skipped}              ${row.coverage ?? '—'}`,
        )
      }
      break
    }
    if (sub === 'show') {
      const reviewId = Number(argv[2])
      if (!Number.isInteger(reviewId) || reviewId <= 0) throw new Error('orch review show <id> [--json]')
      const review = getReview(reviewId)
      if (has('json')) console.log(JSON.stringify(review))
      else {
        console.log(`review ${review.id} recorded=${review.recorded_at} completed=${review.completed_at ?? '—'} projects=${review.projects.join(',') || '—'} tier/risk/size=${review.tier ?? '—'}/${review.risk ?? '—'}/${review.size ?? '—'} current=${review.current_class ?? '—'}`)
        if (review.outdated_reason) console.log(`outdated ${review.outdated_at}: ${review.outdated_reason}`)
        for (const lens of review.lenses) {
          console.log(`lens run ${lens.run_id}: ${lens.lens} ${lens.agent}/${lens.model ?? '—'} tree=${lens.reviewed_tree ?? '—'} head=${lens.head_commit ?? '—'}`)
          console.log(`  ref ${lens.review_ref}: ${lens.pin.resolves ? lens.pin.commit : 'unresolved'}`)
          console.log(`  grading ${Object.entries(lens.grading).map(([key, value]) => `${key}=${value ?? '—'}`).join(' ')}`)
        }
        for (const finding of review.findings as any[]) {
          console.log(`finding ${finding.ordinal} ${finding.severity} ${finding.location} disposition=${finding.disposition ?? 'untriaged'} category=${finding.rejection_category ?? '—'}`)
          console.log(`  evidence: ${finding.evidence}`)
          console.log(`  correction: ${finding.proposed_correction}`)
        }
      }
      break
    }
    if (sub === 'yield') {
      const since = flag('since')
      if (since && !z.iso.datetime().safeParse(since).success) {
        throw new Error('--since must be an ISO datetime (for example 2026-01-01T00:00:00Z)')
      }
      if (flag('task') && flag('key')) throw new Error('--task and --key are aliases; supply only one')
      const { reviewYield, renderReviewYieldHuman } = await import('./review-yield.ts')
      const database = new Database(DB_PATH, { readonly: true })
      try {
        const report = reviewYield({
          project: flag('project'), since, task: flag('task') ?? flag('key'),
          lens: flag('lens'), agent: flag('agent'),
        }, database)
        console.log(has('json') ? JSON.stringify(report) : renderReviewYieldHuman(report))
      } finally {
        database.close()
      }
      break
    }
    if (sub === 'tier') {
      const value = argv[2]
      if (!value) throw new Error('orch review tier <branch|run-id|from..to> [--json]')
      let repo: string
      let from: string
      let to: string
      if (/^\d+$/.test(value)) {
        const runId = Number(value)
        const row = db().query(
          'SELECT repo, job, branch, base_commit, input_tree, head_commit FROM run WHERE id=?',
        ).get(runId) as {
          repo: string | null; job: string; branch: string | null; base_commit: string | null
          input_tree: string | null; head_commit: string | null
        } | null
        if (!row) throw new Error(`no run ${runId}`)
        const project = row.repo ? projectByName(row.repo) : null
        if (!project) throw new Error(`run ${runId} has no registered project`)
        if (!row.base_commit) throw new Error(`run ${runId} has no recorded base commit`)
        // A writer run's input tree IS its base: what it built lives on its
        // branch. Measure the branch tip when the branch still exists. A
        // reader's input tree is the artifact it reviewed, so a reader keeps
        // it even when a branch is recorded (DEV-323).
        const writer = (() => { try { return job(row.job).needs.writesRepo } catch { return false } })()
        const branchLive = writer && row.branch && Bun.spawnSync(
          ['git', 'show-ref', '--verify', '--quiet', `refs/heads/${row.branch}`],
          { cwd: project.path, env: targetGitEnvironment(project.path), stdout: 'pipe', stderr: 'pipe' },
        ).exitCode === 0
        const reviewed = branchLive ? `refs/heads/${row.branch}` : (row.input_tree ?? row.head_commit)
        if (!reviewed) throw new Error(`run ${runId} has no recorded input tree or head commit`)
        repo = project.path; from = row.base_commit; to = reviewed
      } else {
        const project = projectAt(process.cwd())
        if (!project) throw new Error('review tier target is not inside a registered project')
        repo = project.path
        const range = value.match(/^(.+)\.\.(.+)$/)
        if (range) {
          from = range[1]!; to = range[2]!
        } else {
          const branch = Bun.spawnSync(['git', 'show-ref', '--verify', '--quiet', `refs/heads/${value}`], {
            cwd: repo, env: targetGitEnvironment(repo), stdout: 'pipe', stderr: 'pipe',
          })
          if (branch.exitCode !== 0) {
            throw new Error('review tier accepts a branch, run id, or explicit <from>..<to> range')
          }
          const trunk = typeof project.settings.trunk === 'string' ? project.settings.trunk.trim() : ''
          if (!trunk) throw new Error(`project ${project.name} has no trunk configured`)
          const base = Bun.spawnSync(['git', 'merge-base', trunk, value], {
            cwd: repo, env: targetGitEnvironment(repo), stdout: 'pipe', stderr: 'pipe',
          })
          if (base.exitCode !== 0) throw new Error(base.stderr.toString().trim() || 'git merge-base failed')
          from = base.stdout.toString().trim(); to = value
        }
      }
      const tier = classifyReviewTier({ files: diffNumstat(repo, from, to) })
      if (has('json')) console.log(JSON.stringify(tier))
      else {
        console.log(`tier ${tier.tier}`)
        console.log(`risk ${tier.risk}`)
        console.log(`size ${tier.size}`)
        for (const reason of tier.reasons) console.log(reason)
      }
      break
    }
    if (sub === 'coverage-audit') {
      const database = new Database(DB_PATH, { readonly: true })
      try {
        const audit = coverageAudit(database)
        if (has('json')) console.log(JSON.stringify(audit))
        else console.log(
          `${audit.count} completed review${audit.count === 1 ? '' : 's'} reviewed trunk` +
          (audit.review_ids.length ? `: ${audit.review_ids.join(', ')}` : '') +
          `\npartial reviews: ${audit.partial_review_ids.length
            ? audit.partial_review_ids.join(', ') : 'none'}`,
        )
      } finally {
        database.close()
      }
      break
    }
    if (sub === 'record') {
      const runIds = argv.slice(2).map(Number)
      if (!runIds.length || runIds.some((id) => !Number.isInteger(id) || id <= 0)) {
        throw new Error('orch review record <run-id>...')
      }
      const entries = runIds.map((runId) => {
        const row = db().query('SELECT output_path FROM run WHERE id=?').get(runId) as
          { output_path: string | null } | null
        if (!row?.output_path || !existsSync(row.output_path)) {
          throw new Error(`run ${runId} has no recorded output`)
        }
        const output = parseReviewOutput(readFileSync(row.output_path, 'utf8'))
        if (!output) throw new Error(`run ${runId} output does not satisfy the review contract`)
        return { runId, output }
      })
      const reviewId = recordReviews(entries)
      const mirrorRuns = entries.filter(({ runId }) => {
        const row = db().query(
          `SELECT mcp_connected, mcp_error FROM run WHERE id=?`,
        ).get(runId) as { mcp_connected: number | null; mcp_error: string | null }
        return row.mcp_connected === 0 && row.mcp_error?.startsWith('mirror:')
      }).map(({ runId }) => runId)
      console.log(
        `recorded review ${reviewId}` +
        (mirrorRuns.length ? ` — MIRROR lens run${mirrorRuns.length === 1 ? '' : 's'} ${mirrorRuns.join(', ')}` : ''),
      )
      break
    }
    if (sub === 'triage') {
      const reviewId = Number(argv[2])
      const finding = Number(argv[3])
      const disposition = argv[4] as Disposition
      if (!reviewId || !finding || !DISPOSITIONS.includes(disposition)) {
        throw new Error(`orch review triage <review-id> <finding> <accepted|modified|rejected|skipped> [--category X] [--severity ${REVIEW_SEVERITY.join('|')}]`)
      }
      triageFinding(reviewId, finding, disposition, flag('category'), flag('severity'))
      console.log(`triaged review ${reviewId} finding ${finding}: ${disposition}`)
      break
    }
    if (sub === 'complete') {
      const reviewId = Number(argv[2])
      if (!reviewId) throw new Error('orch review complete <review-id>')
      completeReview(reviewId)
      console.log(`completed review ${reviewId}`)
      break
    }
    if (sub === 'pins') {
      const pins = reviewPins(has('prune'))
      if (!pins.length) {
        console.log('no review pins')
        break
      }
      for (const pin of pins) {
        console.log(
          `${pin.project} review ${pin.reviewId} run ${pin.runId} ${pin.commit} ` +
          `completed=${pin.completed} superseded=${pin.superseded} landed=${pin.landed}` +
          (pin.deleted ? ' deleted' : ''),
        )
      }
      break
    }
    if (sub === 'calibration') {
      const [lens, agent, model] = argv.slice(2).filter((value) => value !== '--json')
      if (!lens && !agent && !model) {
        const fleet = reviewCalibrationFleet()
        if (has('json')) console.log(JSON.stringify(fleet))
        else {
          console.log(`review calibration fleet (last ${REVIEW_WINDOW} completed reviews; precision floor ${MIN_REVIEW_TRIAGED} triaged)`)
          if (!fleet.length) console.log('no review calibration evidence')
          for (const cell of fleet) console.log(
            `${cell.lens}/${cell.agent}/${cell.model ?? '—'} n=${cell.n} ` +
            (cell.n < MIN_REVIEW_TRIAGED ? `below floor (${cell.n}/${MIN_REVIEW_TRIAGED} triaged)` : `precision=${cell.precision!.toFixed(2)}`) +
            ` basis=${cell.basis ?? '—'} last_graded_at=${cell.last_graded_at ?? '—'}`,
          )
        }
        break
      }
      if (!lens || !agent || !model) throw new Error('orch review calibration [<lens> <agent> <model>] [--json]')
      const calibration = reviewCalibration(lens, agent, model)
      if (has('json')) {
        console.log(JSON.stringify(calibration))
      } else {
        console.log(calibration.precision === null
          ? `${lens}/${agent}: insufficient evidence (${calibration.triaged} triaged)`
          : `${lens}/${agent}: ${calibration.precision.toFixed(2)} (${calibration.hits}/${calibration.triaged}, ${calibration.basis})`)
        console.log(`  MCP: MIRROR=${calibration.mirror_lenses}`)
        for (const name of ['reproduced', 'coverage', 'limits', 'overlap'] as const) {
          const distribution = calibration[name]
          const cells = Object.keys(distribution.counts).map((value) => {
            const count = distribution.counts[value as keyof typeof distribution.counts]
            const share = distribution.shares[value as keyof typeof distribution.shares]
            return `${value}=${count}` + (share === null ? '' : ` (${(share * 100).toFixed(0)}%)`)
          })
          console.log(`  ${name}: ${cells.join(', ')}, ungraded=${distribution.ungraded}`)
        }
        const severity = calibration.severity
        console.log(`  severity: agreed=${severity.counts.agreed}, changed=${severity.counts.changed}, not-comparable=${severity.counts.not_comparable}, not-assessed=${severity.counts.not_assessed}`)
        for (const [tier, counts] of Object.entries(calibration.tiers)) {
          console.log(`  tier ${tier}: reviews=${counts.reviews}, lenses=${counts.lenses}, accepted=${counts.findings_accepted}, rejected=${counts.findings_rejected}, rounds=${counts.rounds.min ?? '—'}/${counts.rounds.median ?? '—'}/${counts.rounds.max ?? '—'} min/median/max`)
        }
      }
      break
    }
    throw new Error(`unknown: orch review${sub ? ` ${sub}` : ''}. Try tier | record | triage | complete | calibration`)
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
    let retryAuthority = authorizeRunMutation(id, 'retry')
    const row = db().query(
      `SELECT id, COALESCE(parent_run_id,id) root_id, agent, job, cwd, prompt_path,
              probe, status, failure_kind, mcp, mcp_error,
              schema_path, model, lens, launch_cwd, launch_seed, launch_key, launch_base, no_failover,
              keep_tree
         FROM run WHERE id = ?`,
    ).get(id) as {
      id: number; root_id: number; agent: string; job: string; cwd: string | null
      prompt_path: string | null; probe: number; status: string; failure_kind: string | null
      mcp: number | null; mcp_error: string | null; schema_path: string | null; model: string | null; lens: string | null
      launch_cwd: string | null; launch_seed: string | null; launch_key: string | null; launch_base: string | null
      no_failover: number; keep_tree: number
    } | null
    if (!row) throw new Error(`no run ${id}`)
    // A writing job already has a worktree and a vendor session. Retry would
    // wrap the prompt again and cut a fresh tree beside the one holding the
    // partial edit. Continue the same conversation in the same tree instead.
    const recordedRulings = db().query(
      `SELECT q.question, q.answer
         FROM question q JOIN run owner ON owner.id = q.run_id
        WHERE (owner.id = ? OR owner.parent_run_id = ?)
          AND q.delivery_pending_at IS NOT NULL AND q.answer IS NOT NULL
        ORDER BY q.id`,
    ).all(row.root_id, row.root_id) as { question: string; answer: string }[]
    if (job(row.job).needs.writesRepo && !recordedRulings.length) {
      const requested = flag('agent')
      if (requested && requested !== row.agent) {
        throw new Error(
          `a writing run continues on its own agent (${row.agent}); to start over on ${requested}: ` +
          `orch do ${row.job} --agent ${requested} ...`,
        )
      }
      const resumed = await continueRun(id)
      auditRunMutation(retryAuthority, 'retry', `continued as run ${resumed.childId}`)
      await reportContinuedRun(resumed.childId, resumed.job)
      break
    }
    if (!row.prompt_path || !existsSync(row.prompt_path)) {
      throw new Error(
        `run ${id} has no prompt on disk — it predates prompt capture, or the file has aged out ` +
          `after ${KEEP_RUN_FILES_DAYS} days. Nothing to re-send.`,
      )
    }
    // The SAME agent by default, which is the whole point. A quota limit or a
    // dropped connection is a fact about the moment, not about the agent, and
    // routing around it starts a different agent from scratch on work the first
    // one had already partly done.
    const agent = flag('agent') ?? row.agent
    if (recordedRulings.length && job(row.job).needs.writesRepo) {
      console.error(
        `— recorded rulings require a fresh worktree; retry will not carry the previous partial edit`,
      )
    }
    console.error(
      `— retrying run ${id} (${row.agent}/${row.job}` +
        (row.failure_kind ? `, ${row.failure_kind}` : '') + `) on ${agent}`,
    )
    retryAuthority = writeTransaction(() => adoptRunMutation(retryAuthority, 'retry'))
    // Detached and followed, exactly like `do`. A retry is usually started
    // BECAUSE the first attempt died; running it as a child of this process
    // would leave it dying the same way.
    const originalPrompt = readFileSync(row.prompt_path, 'utf8')
    const retryPrompt = recordedRulings.length
      ? `${originalPrompt}\n\n---\n\n${rulingPrompt(recordedRulings)}`
      : originalPrompt
    const dispatch = readDispatchState(row.root_id)
    const newId = await detach(row.job, retryPrompt, {
      agent,
      schema: row.schema_path ?? undefined,
      mcp: mcpRequestFromStored(row.mcp, row.mcp_error),
      model: retryModelForAgent(row.agent, row.model, agent, flag('model')),
      lens: row.lens ?? undefined,
      probe: !!row.probe, retryOf: id, cwd: row.launch_cwd ?? row.cwd ?? undefined,
      seed: row.launch_seed ?? undefined, key: row.launch_key ?? undefined,
      base: row.launch_base ?? undefined, noFailover: !!row.no_failover,
      transport: chainTransport(row.root_id) ?? undefined,
      keepTree: !!row.keep_tree,
      deliverables: dispatch.deliverables,
      timeoutMinutes: dispatch.timeoutMinutes ?? undefined,
    })
    auditRunMutation(retryAuthority, 'retry', `retried as run ${newId}`)
    console.error(`— run ${newId} is retry of ${id}`)
    await follow(newId, has('quiet'))
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
    const { projects, upsertProject, removeProject, sniffStack, projectByName,
            worktreeWarnings, validateProjectSettings, migrateCreate, assertRegisterBranches } = await import('./projects.ts')
    const sub = argv[1] ?? 'list'

    if (sub === 'list') {
      const all = projects()
      /**
       * PUBLISHED, because hub cannot import this concern and must not open
       * `orch.db`.
       *
       * The boundary check forbids the import and a shared database would make
       * two concerns one, so what another concern needs is emitted here — the
       * same contract `orch state` already serves the dashboard under. A
       * project's identity, stack and settings are exactly the facts hub needs
       * to stop knowing four repository names of its own.
       */
      if (has('json')) {
        console.log(JSON.stringify(all.map((project) => ({
          ...project,
          problems: validateProjectSettings(project.settings),
          commit_hooks_skipped: true,
          gate: typeof project.settings.gate === 'string' ? project.settings.gate : null,
        }))))
        break
      }
      if (!all.length) {
        console.log(
          'no projects registered.\n\n' +
          '  orch project add <path> [--name X] [--stack Y] [--no-canon] [--json]\n\n' +
          'The stack is what lets routing tell "good at PHP" from "good at Vue";\n' +
          'two projects sharing one stack pool their evidence.',
        )
        break
      }
      for (const p of all) {
        console.log(
          `${p.name.padEnd(14)} ${(p.stack ?? '—').padEnd(22)} ` +
          `${p.canon ? 'canon' : '     '}  ${p.path}`,
        )
        const keys = Object.keys(p.settings)
        if (keys.length) console.log(`${' '.repeat(14)} settings: ${keys.join(', ')}`)
        for (const problem of validateProjectSettings(p.settings)) {
          console.log(`${p.name}: ${problem}`)
        }
        // Reported, not enforced: a half-configured project should say so and
        // keep working. Every one of these is a state that has actually
        // happened rather than one imagined here.
        for (const w of worktreeWarnings(p)) {
          console.log(`${' '.repeat(14)} ! ${w}`)
        }
      }
      break
    }

    if (sub === 'add') {
      const path = (argv[2] ?? process.cwd()).replace(/\/$/, '')
      if (!existsSync(path)) throw new Error(`no such directory: ${path}`)
      const name = flag('name') ?? path.split('/').filter(Boolean).pop()!
      // Sniffed only as a SUGGESTION, at the one moment a person is looking
      // straight at the project and can correct it. A guess that reruns on
      // every routing decision is a guess nobody ever reviews.
      const stack = flag('stack') ?? sniffStack(path)
      let settings = {} as import('./projects.ts').ProjectSettings
      if (flag('settings')) {
        try { settings = JSON.parse(flag('settings')!) as typeof settings }
        catch (e) { throw new Error(`--settings must be JSON: ${e}`) }
        const malformed = validateProjectSettings(settings)
        if (malformed.length) throw new Error(malformed.join('\n'))
      }
      const candidate = { id: 0, name, path, stack, canon: !has('no-canon'), settings }
      const incomplete = worktreeWarnings(candidate).filter((w) =>
        w.startsWith('has a create command but no branch template') ||
        w.startsWith('has a create command with a {seed} placeholder but no seeds list'))
      if (incomplete.length && !has('allow-incomplete')) throw new Error(incomplete.join('\n'))
      assertRegisterBranches(candidate)
      upsertProject(candidate)
      if (has('json')) {
        console.log(JSON.stringify(projectByName(name)))
        break
      }
      console.log(`registered ${name}  ${stack ?? '(no stack — orch project set ' + name + ' --stack ...)'}  ${path}`)
      for (const w of worktreeWarnings(projectByName(name)!)) {
        console.log(`${' '.repeat(14)} ! ${w}`)
      }
      break
    }

    if (sub === 'set') {
      const name = argv[2]
      if (!name) throw new Error('orch project set <name> [--stack X] [--path P] [--canon|--no-canon] [--settings JSON] [--json]')
      const p = projectByName(name)
      if (!p) throw new Error(`no project "${name}"`)
      /**
       * Merged DEEPLY, because one level was not enough.
       *
       * A settings blob holds unrelated concerns written at different times —
       * tracker vocabulary, trunk name, colour, the whole worktree lifecycle —
       * and replacing it wholesale to change one drops the others. A shallow
       * merge only moved the problem down a level: updating `worktree.notes`
       * replaced the entire `worktree` object and silently discarded its
       * create, remove, sweep and branch template. Which happened to one project,
       * minutes after the comment above was written promising it would not.
       *
       * Objects merge; JSON null deletes; anything else replaces. An array is
       * a value someone meant to set, not a thing to append to.
       */
      const deepMerge = (a: Record<string, unknown>, b: Record<string, unknown>) => {
        const out: Record<string, unknown> = { ...a }
        for (const [k, v] of Object.entries(b)) {
          if (v === null) {
            delete out[k]
            continue
          }
          const prev = out[k]
          out[k] = v && typeof v === 'object' && !Array.isArray(v)
                && prev && typeof prev === 'object' && !Array.isArray(prev)
            ? deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>)
            : v
        }
        return out
      }
      let settings = p.settings
      if (flag('settings')) {
        try { settings = deepMerge(settings, JSON.parse(flag('settings')!)) as typeof settings }
        catch (e) { throw new Error(`--settings must be JSON: ${e}`) }
      }
      const nextName = flag('name') ?? name
      const candidate = {
        id: p.id,
        name: nextName,
        path: flag('path') ?? p.path,
        stack: flag('stack') ?? p.stack,
        canon: has('no-canon') ? false : has('canon') ? true : p.canon,
        settings,
      }
      const malformed = validateProjectSettings(candidate.settings).filter((problem) =>
        !(typeof p.settings.worktree?.create === 'string' &&
          candidate.settings.worktree?.create === p.settings.worktree.create &&
          problem === 'worktree.create is a shell string; migrate it (DEV-308)'))
      if (malformed.length) throw new Error(malformed.join('\n'))
      const incomplete = worktreeWarnings(candidate).filter((w) =>
        w.startsWith('has a create command but no branch template') ||
        w.startsWith('has a create command with a {seed} placeholder but no seeds list'))
      if (incomplete.length && !has('allow-incomplete')) throw new Error(incomplete.join('\n'))
      assertRegisterBranches(candidate)
      if (nextName !== name) renameProject(name,nextName)
      const previousTrunk = typeof p.settings.trunk === 'string' ? p.settings.trunk : null
      const nextTrunk = typeof candidate.settings.trunk === 'string' ? candidate.settings.trunk : null
      writeTransaction(() => {
        upsertProject(candidate)
      })
      if (previousTrunk !== nextTrunk) {
        tryWriteContention({
          resourceKind: 'register', resourceKey: nextName, eventKind: 'invalidation',
          cause: `trunk ${previousTrunk ?? '(unset)'} -> ${nextTrunk ?? '(unset)'}`,
        })
      }
      if (has('json')) {
        console.log(JSON.stringify(projectByName(nextName)))
        break
      }
      console.log(`updated ${nextName}`)
      for (const w of worktreeWarnings(projectByName(nextName)!)) {
        console.log(`${' '.repeat(14)} ! ${w}`)
      }
      break
    }

    if (sub === 'select-profile') {
      const { selectProjectProfile }=await import('./lenses.ts')
      const name=argv[2],axis=flag('axis'),profile=flag('name'),reason=flag('reason'),versionText=flag('version')
      if(!name||!axis||!profile||!reason?.trim())throw new Error('orch project select-profile <project> --axis A --name N [--lens ID] [--version N] --reason TEXT')
      const version=versionText===undefined?undefined:Number(versionText)
      const result=selectProjectProfile({project:name,axis,name:profile,lensId:flag('lens'),version,reason})
      console.log(has('json')?JSON.stringify(result):`selected ${axis}/${profile} for ${name}${flag('lens')?` lens ${flag('lens')}`:' all lenses'}`)
      break
    }

    if (sub === 'migrate-create') {
      const name = argv[2]
      if (!name) throw new Error('orch project migrate-create <name> [--apply]')
      const p = projectByName(name)
      if (!p) throw new Error(`no project "${name}"`)
      const create = p.settings.worktree?.create
      if (create === undefined && p.settings.worktree?.recipe) {
        console.log(`${name}: worktree.create is a recipe; nothing to migrate`)
        break
      }
      if (typeof create !== 'string') {
        console.log(`${name}: worktree.create is already structured; nothing to migrate`)
        break
      }
      console.log(`${name}: before ${JSON.stringify(create)}`)
      const migration = migrateCreate(create)
      if (migration.kind === 'refused') {
        console.log(`${name}: ${migration.message}`)
        break
      }
      console.log(`${name}: after  ${JSON.stringify(migration.after)}`)
      if (has('apply')) {
        upsertProject({
          ...p,
          settings: {
            ...p.settings,
            worktree: { ...p.settings.worktree!, create: migration.after },
          },
        })
      }
      break
    }

    if (sub === 'remove') {
      const name = argv[2]
      if (!name) throw new Error('orch project remove <name>')
      // The RUNS stay. They are evidence about agents, and that evidence did
      // not stop being true because the project was deregistered.
      console.log(removeProject(name) ? `removed ${name}` : `no project "${name}"`)
      break
    }

    throw new Error(`unknown: orch project ${sub}. Try list | add | set | remove`)
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
    await loadJobs()
    const sid = sessionId()
    const mine = !has('all')
    const project = mine ? projectAt(process.cwd()) : null
    const cutoff = new Date(Date.now() - SESSION_LIVE_MS).toISOString()
    const hasSessionSeen = Boolean(db().query(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_seen'`,
    ).get())
    const seenJoin = hasSessionSeen
      ? 'LEFT JOIN session_seen seen ON seen.session_id = r.session_id'
      : ''
    const sessionRecent = hasSessionSeen
      ? 'CASE WHEN r.session_id IS NOT NULL AND seen.last_seen >= ? THEN 1 ELSE 0 END'
      : '0'
    const allRows = db().query(
      `SELECT q.id, q.run_id, q.asked_at, q.question, q.options, q.recommendation, q.why,
              r.agent, r.job, r.repo, r.status, r.session_id,
              root.status root_status,
              ${activeSql('root')} root_active,
              ${voidedSql('root')} root_voided,
              COALESCE(r.parent_run_id, r.id) root_id,
              ${sessionRecent} session_recent
         FROM question q JOIN run r ON r.id = q.run_id
         JOIN run root ON root.id = COALESCE(r.parent_run_id, r.id)
         ${seenJoin}
        WHERE ${mine
          ? `q.answered_at IS NULL AND ${activeSql('root')}`
          : `q.answered_at IS NULL OR NOT (${activeSql('root')})`}
        ORDER BY q.run_id, q.id`,
    ).all(...(hasSessionSeen ? [cutoff] : [])) as {
      id: number; run_id: number; asked_at: string; question: string; options: string | null
      recommendation: string | null; why: string | null
      agent: string; job: string; repo: string | null; status: string; session_id: string | null
      root_status: string; root_active: number; root_voided: number
      root_id: number; session_recent: number
    }[]
    // The default is a VIEW of the project containing cwd. Ownership remains
    // the session that dispatched the run; choosing what is visible must never
    // silently make it answerable. Outside a registered project, retain the
    // old session-scoped fallback rather than guessing a project from the path.
    const rows = mine
      ? project
        ? allRows.filter((q) => q.repo === project.name)
        : allRows.filter((q) => sid !== null && q.session_id === sid)
      : allRows
    const canAnswer = (owner: string | null) => owner === null || (sid !== null && owner === sid)
    const active = rows.filter((q) => q.root_active)
    const terminal = rows.filter((q) => !active.includes(q))
    const answerable = active.filter((q) => canAnswer(q.session_id))
    const visible = active.filter((q) => !canAnswer(q.session_id))

    if (has('json')) {
      console.log(JSON.stringify(rows.map((q) => ({
        question_id: q.id,
        run_id: q.run_id,
        answer_id: q.root_id,
        job: q.job,
        agent: q.agent,
        repo: q.repo,
        asked_at: q.asked_at,
        // Kept as a nullable compatibility field: false used to assert death,
        // which a last-seen timestamp cannot establish.
        session_live: q.session_recent ? true : null,
        session_liveness: q.session_recent ? 'live' : 'unknown',
        can_answer: Boolean(q.root_active) && canAnswer(q.session_id),
        question: q.question,
        options: q.options ? JSON.parse(q.options) as string[] : [],
        recommendation: q.recommendation,
        why: q.why,
        status: q.root_voided ? 'voided' : q.root_status,
      }))))
      break
    }

    const recoverable = db().query(
      `SELECT root.id, root.agent, root.job, root.repo, root.session_id
         FROM run root
        WHERE root.parent_run_id IS NULL
          AND (root.status = 'asking' OR EXISTS (
            SELECT 1 FROM question pending JOIN run owner ON owner.id=pending.run_id
             WHERE (owner.id=root.id OR owner.parent_run_id=root.id)
               AND pending.answered_at IS NOT NULL
               AND pending.delivery_pending_at IS NOT NULL
          ))
          ${mine
            ? project
              ? 'AND root.repo = ?'
              : 'AND root.session_id = ?'
            : ''}
          AND NOT EXISTS (
            SELECT 1 FROM question q JOIN run owner ON owner.id = q.run_id
             WHERE (owner.id = root.id OR owner.parent_run_id = root.id)
               AND q.answered_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM run active
             WHERE active.parent_run_id = root.id AND active.status = 'running'
          )
        ORDER BY root.id`,
    ).all(...(mine ? project ? [project.name] : [sid] : [])) as {
      id: number; agent: string; job: string; repo: string | null; session_id: string | null
    }[]

    if (!rows.length && !recoverable.length) {
      console.log(mine && project ? `no open questions for ${project.name}`
        : mine ? 'no questions waiting on you' : 'no open questions')
      break
    }
    let lastRun = -1
    let lastRoot = -1
    for (const q of answerable) {
      if (q.run_id !== lastRun) {
        console.log(`\nrun ${q.run_id} · ${q.agent}/${q.job}${q.repo ? ` · ${q.repo}` : ''} · ${q.status}`)
        lastRun = q.run_id
      }
      lastRoot = q.root_id
      console.log(`  [q${q.id}] ${q.question}`)
      if (q.why) console.log(`        why: ${q.why}`)
      const opts = q.options ? (JSON.parse(q.options) as string[]) : []
      for (const o of opts) console.log(`        - ${o}`)
      if (q.recommendation) console.log(`        it would: ${q.recommendation}`)
      if (q.session_id === null) {
        console.log('        unowned — any session may rule, and the answering identity is recorded')
      }
    }
    if (answerable.length) {
      console.log(
        `\nrule on them:  orch answer ${lastRoot} "<ruling>"    (one per question, in order)` +
        `\n               orch answer ${lastRoot} --q<id> "<ruling>"`,
      )
    }
    for (const r of recoverable) {
      const stranded = chainHasPendingDelivery(r.id)
      if (canAnswer(r.session_id)) {
        console.log(
          `\nrun ${r.id} · ${r.agent}/${r.job}${r.repo ? ` · ${r.repo}` : ''} · ` +
          (stranded
            ? `asking, but no ruling is open — ${strandedRecovery(r.id)}`
            : `asking, but no ruling is open — recoverable: orch continue ${r.id}`),
        )
        if (r.session_id === null) {
          console.log('        unowned — any session may continue it')
        }
      } else {
        console.log(
          `\nrun ${r.id} · ${r.agent}/${r.job}${r.repo ? ` · ${r.repo}` : ''} · ` +
          `asking, but no ruling is open · owner ${r.session_id} · visible only; ` +
          (stranded
            ? `stranded — only the owning session may use orch retry ${r.id} --agent … or orch abandon ${r.id}`
            : 'only the owning session may continue it'),
        )
      }
    }
    if (visible.length) {
      console.log('\nvisible here, but owned by another session:')
    for (const q of visible) {
        const liveness = q.session_recent ? 'live' : 'unknown'
        console.log(
          `\n  [q${q.id}] run ${q.run_id} · ${q.job} · ${q.agent}` +
          `${q.repo ? ` · ${q.repo}` : ''} · owner ${q.session_id ?? 'unknown'} · ` +
          `liveness ${liveness} · waiting ${dur(Date.now() - Date.parse(q.asked_at))}`,
        )
        console.log(`        ${q.question}`)
        if (q.why) console.log(`        why: ${q.why}`)
        const opts = q.options ? (JSON.parse(q.options) as string[]) : []
        for (const o of opts) console.log(`        - ${o}`)
        if (q.recommendation) console.log(`        recommendation: ${q.recommendation}`)
        console.log('        only the owning session may rule; visibility does not transfer authority')
      }
    }
    for (const q of terminal) {
      const status = q.root_voided ? 'voided' : q.root_status
      console.log(
        `\nrun ${q.root_id} · ${q.agent}/${q.job}${q.repo ? ` · ${q.repo}` : ''} · ` +
        `${status} (terminal)`,
      )
      console.log(`  [q${q.id}] ${q.question}`)
    }
    break
  }

  /**
   * Rule on what a worker asked, and set it going again.
   *
   * The ruling RESUMES the worker's own session rather than starting a new run,
   * which is the entire reason escalation is affordable here: everything the
   * worker had read is still in its head, so a design question costs one short
   * turn instead of a second full survey of the code. Starting fresh would make
   * asking more expensive than guessing, and a channel that costs more than
   * guessing does not get used.
   */
  case 'answer': {
    await Promise.all([loadJobs(), loadAgents(), loadRoute(), loadRun(), loadWorktree(), loadContract()])
    const requestedId = Number(argv[1])
    if (!requestedId) usage()
    const row = db().query(
      `SELECT root.id, root.agent, root.job, root.cwd, root.worktree, root.branch,
              root.base_commit, root.vendor_session, root.status, root.session_id,
              root.turn, root.parent_run_id, root.worktree_source, root.evidence_excluded
         FROM run requested
         JOIN run root ON root.id = COALESCE(requested.parent_run_id, requested.id)
        WHERE requested.id = ?`,
    ).get(requestedId) as {
      id: number; agent: string; job: string; cwd: string | null
      worktree: string | null; branch: string | null; base_commit: string | null
      vendor_session: string | null; status: string; session_id: string | null
      turn: number; parent_run_id: number | null
      worktree_source: Worktree['source'] | null
      evidence_excluded: string | null
    } | null
    if (!row) throw new Error(`no run ${requestedId}`)
    const id = row.id
    refuseEscapedChain(id)
    let answerAuthority = authorizeRunMutation(requestedId, 'answer')

    /**
     * Questions are collected ACROSS THE WHOLE CHAIN, not just off the root.
     *
     * A worker that blocks on turn two records its questions against the CHILD
     * row while the roll-up marks the ROOT blocked. Looking only at the root
     * found nothing to answer and looking at the child was refused as
     * non-root — so a conversation that asked twice could not be continued at
     * all. Found in review, and it is the shape every multi-turn escalation
     * takes after the first.
     */
    const open = db().query(
      `SELECT q.id, q.question, r.id owner_id, r.status owner_status, r.pid owner_pid
         FROM question q JOIN run r ON r.id = q.run_id
        WHERE (r.id = ? OR r.parent_run_id = ?) AND q.answered_at IS NULL
        ORDER BY q.id`,
    ).all(id, id) as {
      id: number; question: string; owner_id: number
      owner_status: string; owner_pid: number | null
    }[]
    if (!open.length) {
      const asked = db().query(
        `SELECT COUNT(*) n FROM question q JOIN run r ON r.id = q.run_id
          WHERE r.id = ? OR r.parent_run_id = ?`,
      ).get(id, id) as { n: number }
      throw new Error(
        asked.n
          ? `run ${id} has already been ruled on; its current status is ${row.status}`
          : `run ${id} has no questions to answer; its current status is ${row.status}`,
      )
    }

    // A ruling resumes a live chain. Stopped, failed, stale and voided roots
    // used to record the answer and spawn a new turn, which is retry's job.
    if (row.evidence_excluded !== null ||
        (row.status !== 'running' && row.status !== 'asking')) {
      throw new Error(
        `run ${id} is ${row.evidence_excluded !== null ? 'voided' : row.status}. ` +
        'invariant: a ruling resumes a live chain; a terminal chain is retried or abandoned. ' +
        `orch retry ${id} --agent <name> (carries the recorded ruling) or orch abandon ${id}`,
      )
    }

    // A last-seen timeout used to make a question appear adoptable, and this
    // command then accepted the adoption. Only the architect session that
    // dispatched the conversation has standing to change its specification.
    const callerSession = answerAuthority.actor
    if (!row.session_id && callerSession) {
      console.error(
        `run ${id} is unowned; session ${callerSession} may rule and will adopt the chain, ` +
        'and that answering identity will be recorded',
      )
    }

    /**
     * TWO WAYS A QUESTION ARRIVES, and they are answered differently.
     *
     * `blocked` means the worker ended its turn and is waiting to be resumed —
     * the ruling has to start it again. `running` means the worker is ALIVE and
     * sitting inside an `ask_orchestrator` tool call, so writing the answer is
     * the entire delivery: it is polling for exactly that row, and resuming a
     * process that never stopped would start a second worker on the same
     * worktree.
     *
     * This is the defect the live channel shipped with. Questions asked through
     * MCP land against a `running` run, and this command accepted nothing but
     * `blocked` — so the tool could never be answered and every live question
     * ran to its timeout. The headline feature did not work end to end, and the
     * test that "proved" it wrote the answer with raw SQL, bypassing the very
     * guard that was refusing it.
     */
    const live = open.filter((q) =>
      (q.owner_status === 'running' || q.owner_status === 'asking') && pidAlive(q.owner_pid))
    const stopped = open.filter((q) => !live.includes(q))
    if (live.length && stopped.length) {
      const list = (questions: typeof open) => questions
        .map((q) => `q${q.id} (run ${q.owner_id}, ${q.owner_status})`).join(', ')
      throw new Error(
        `run ${id} has questions owned by both live and stopped turns. ` +
        `Live: ${list(live)}. Stopped: ${list(stopped)}. Refusing to rule; inspect the run chain.`,
      )
    }
    const ownersLive = live.length > 0
    const recordOnly = has('record-only')
    const skipResume = recordOnly && !ownersLive
    if (!ownersLive && !stopped.every((q) =>
      q.owner_status === 'asking' || q.owner_status === 'running')) {
      const states = stopped.map((q) => `q${q.id} (run ${q.owner_id}, ${q.owner_status})`).join(', ')
      throw new Error(`run ${id} has questions whose owners are not waiting: ${states}`)
    }

    const latest = db().query(
      `SELECT id, agent, vendor_session, turn, cwd, worktree, branch, base_commit, worktree_source
         FROM run WHERE id = ? OR parent_run_id = ?
        ORDER BY turn DESC LIMIT 1`,
    ).get(id, id) as {
      id: number; agent: string; vendor_session: string | null; turn: number
      cwd: string | null; worktree: string | null; branch: string | null; base_commit: string | null
      worktree_source: Worktree['source'] | null
    }
    const sessionFrom = latest.vendor_session
      ? latest
      : db().query(
          `SELECT id, agent, vendor_session, turn
             FROM run WHERE (id = ? OR parent_run_id = ?) AND vendor_session IS NOT NULL
            ORDER BY turn DESC LIMIT 1`,
        ).get(id, id) as {
          id: number; agent: string; vendor_session: string; turn: number
        } | null
    const resumeAgent = sessionFrom?.agent ?? latest.agent

    // Two ways to rule: one joined positional / --file / stdin message, or
    // by question id when there are several. `--q<id> --file PATH` binds that
    // file to that question; a command-level `--file` is the single-ruling form.
    const answers: { id: number; question: string; answer: string }[] = []
    const parsed = parseAnswerTextSources(argv.slice(2))
    const argvLimit = ownersLive ? undefined : argvResumeLimit(resumeAgent)
    const rulingFrom = (text: string): string => {
      assertWorkerText(text, 'ruling', ANSWER_WORKING_FORMS, argvLimit)
      return text
    }
    if (parsed.byId.length) {
      if (parsed.commandFile !== undefined || parsed.positionals.length) {
        throw new Error(
          'pass --file next to each --q<id>, not as a command-level flag or positional alongside --q\n' +
          `working forms:\n${ANSWER_WORKING_FORMS}`,
        )
      }
      const invalid: string[] = []
      const seen = new Set<number>()
      for (const src of parsed.byId) {
        if (seen.has(src.id)) invalid.push(`--q${src.id} given more than once`)
        seen.add(src.id)
        if (open.some((q) => q.id === src.id)) continue
        const named = db().query(
          `SELECT q.id, q.answered_at, r.id AS run_id,
                  COALESCE(r.parent_run_id, r.id) AS root_id
             FROM question q JOIN run r ON r.id = q.run_id WHERE q.id = ?`,
        ).get(src.id) as
          { id: number; answered_at: string | null; run_id: number; root_id: number } | null
        if (!named) {
          invalid.push(`--q${src.id} names no question`)
        } else if (named.root_id !== id) {
          invalid.push(`--q${src.id} belongs to run ${named.root_id}, not this chain`)
        } else if (named.answered_at) {
          invalid.push(`--q${src.id} on run ${named.run_id} is already closed`)
        } else {
          invalid.push(`--q${src.id} is not open on this chain`)
        }
      }
      if (invalid.length) {
        throw new Error(
          `refusing the whole ruling: ${invalid.join('; ')}\n` +
          `nothing was stored\nworking forms:\n${ANSWER_WORKING_FORMS}`,
        )
      }
      for (const q of open) {
        const src = parsed.byId.find((item) => item.id === q.id)
        if (!src) continue
        const given = src.file !== undefined ? readWorkerFile(src.file) : src.text!
        answers.push({ id: q.id, question: q.question, answer: rulingFrom(given) })
      }
    } else {
      const positional = parsed.positionals
      if (parsed.commandFile !== undefined || (!positional.length && !process.stdin.isTTY)) {
        const given = await readMessageText({
          missing: 'no ruling: pass it as an argument, via --file, or on stdin',
          exclusive: 'pass the ruling either positionally or with --file, not both',
          sources: parsed,
        })
        answers.push({ id: open[0]!.id, question: open[0]!.question, answer: rulingFrom(given!) })
      } else if (!positional.length) {
        throw new Error(
          `run ${id} is waiting on ${open.length} question(s). ` +
          `Rule with: orch answer ${id} --q${open[0]!.id} "<ruling>", ` +
          'or pass a ruling via --file or stdin.',
        )
      } else {
        // One reader: positional words join into one message, never one-per-question.
        answers.push({
          id: open[0]!.id,
          question: open[0]!.question,
          answer: rulingFrom(positional.join(' ')),
        })
      }
    }
    if (answers.length !== open.length) {
      throw new Error(
        `${open.length} question(s) open but ${answers.length} ruling(s) given. ` +
        'For multiple questions, pass every --q<id> in a single command. ' +
        'A worker resumed with a question unanswered will guess, which is the ' +
        'one thing this is here to prevent.',
      )
    }

    if (!ownersLive && !skipResume &&
        (!sessionFrom?.vendor_session || AGENTS[resumeAgent]?.caps.resumable === false)) {
      throw new Error(
        `run ${id} cannot be resumed: no vendor session (agent ${resumeAgent}); ` +
        `the ruling was NOT recorded; options: \`orch retry ${id} --agent …\` to ` +
        `re-dispatch with the ruling appended to the spec, or \`orch abandon ${id}\``,
      )
    }
    if (!ownersLive) {
      const assembledLimit = argvResumeLimit(resumeAgent)
      if (assembledLimit !== undefined) {
        const turnPrompt = rulingPrompt(answers)
        const packed = packedResumePrompt(row.job, turnPrompt, id)
        const assembled = Buffer.byteLength(packed, 'utf8')
        if (assembled > assembledLimit) {
          const shrink = [...answers]
            .map((a) => ({ id: a.id, bytes: Buffer.byteLength(a.answer, 'utf8') }))
            .sort((a, b) => b.bytes - a.bytes || a.id - b.id)
            .map((a) => `--q${a.id} (${a.bytes} bytes)`)
            .join(', ')
          throw new Error(
            `assembled resume prompt is ${assembled} bytes; this agent's resume transport is bounded at ${assembledLimit} bytes\n` +
            `rulings that would need to shrink: ${shrink}\n` +
            `nothing was stored\nworking forms:\n${ANSWER_WORKING_FORMS}`,
          )
        }
      }
    }

    const now = nowIso()
    const upd = db().query(
      `UPDATE question
          SET answer=?, answered_at=?, answered_by=?, delivery_pending_at=?
        WHERE id=?`,
    )
    const answeredBy = callerSession ?? 'anonymous (no session id)'
    writeTransaction(() => {
      answerAuthority = adoptRunMutation(answerAuthority, 'answer')
      open.forEach((q, i) => upd.run(
        answers[i]!.answer, now, answeredBy, ownersLive ? null : now, q.id,
      ))
      if (skipResume) db().query("UPDATE run SET status='asking' WHERE id=?").run(id)
      auditRunMutation(answerAuthority, 'answer')
    })

    if (skipResume) {
      console.log(
        `recorded ${answers.length} ruling(s) for run ${id}; resume was skipped by --record-only. ` +
        `The run remains asking; use orch retry ${id} --agent … to re-dispatch with the ruling appended to the spec, ` +
        `or orch abandon ${id}.`,
      )
      break
    }

    if (ownersLive) {
      // Delivered. The worker's own tool call is polling this row and will
      // return with it inside a second; there is nothing else to do, and
      // starting a new turn here would put two workers in one worktree.
      console.log(
        `ruled on ${answers.length} question(s) — the owning turn is still working and will ` +
        `pick this up from its ask_orchestrator call.`,
      )
      break
    }

    const worktreePath = latest.worktree ?? row.worktree
    /**
     * DETACHED, for the reason `orch do` already is.
     *
     * A resumed turn is a full agent run — minutes, not seconds — and run in
     * the foreground it outlives an agent harness's command timeout, which
     * kills the whole process group and takes the worker down with it. That is
     * not hypothetical: it happened on the first multi-turn ruling of real
     * work, and the worker had finished and written its reply when the group
     * was killed. This command was the last place still doing what the canon's
     * own section says loses the work.
     */
    let childId: number
    try {
      childId = await detach(row.job, rulingPrompt(answers), {
        cwd: latest.cwd ?? row.cwd ?? process.cwd(),
        transport: chainTransport(id) ?? undefined,
        resume: {
          parent: id,
          agent: resumeAgent,
          session: sessionFrom!.vendor_session!,
          turn: latest.turn + 1,
          sessionId: row.session_id,
          worktree: worktreePath
            ? {
                path: worktreePath,
                branch: latest.branch ?? row.branch ?? '',
                base: latest.base_commit ?? row.base_commit ?? '',
                repoRoot: (await import('./worktree.ts')).repoRootOf(worktreePath) ?? process.cwd(),
                source: latest.worktree_source ?? row.worktree_source ?? undefined,
              }
            : null,
        },
      })
    } catch (e) {
      writeTransaction(() => {
        for (const q of open) {
          db().query(
            `UPDATE question
                SET answer=NULL, answered_at=NULL, answered_by=NULL, delivery_pending_at=NULL
              WHERE id=?`,
          ).run(q.id)
        }
      })
      throw new Error(
        `Resume failed: ${(e as Error).message}\n` +
        `The ruling was rolled back and the question is still open.`,
      )
    }
    console.log(`ruled on ${answers.length} question(s); resumed run ${id} as run ${childId}`)
    if (has('detach') || !has('follow')) {
      if (!has('quiet')) {
        console.error(
          `\n— ${row.job} runs detached; a foreground one dies with its shell.` +
          `\n  orch wait ${childId}      then:  orch result ${childId}` +
          `\n  orch inbox          if it stops to ask` +
          `\n  --follow            to watch it here instead`,
        )
      }
      break
    }
    const resumedStatus = await follow(childId, has('quiet'), false)
    if (resumedStatus !== 'ok' && resumedStatus !== 'asking') {
      const failed = db().query(
        `SELECT status, error, failure_kind, exit_code FROM run WHERE id=?`,
      ).get(childId) as {
        status: string; error: string | null; failure_kind: string | null; exit_code: number | null
      }
      throw new Error(
        `the rulings ARE recorded and were not lost, but resumed run ${childId} failed: ` +
        `${failureReason(failed)}\nRetry it with: orch continue ${id}`,
      )
    }
    const done = db().query('SELECT status FROM run WHERE id = ?').get(id) as { status: string }
    console.error(
      done.status === 'asking'
        ? `\n  STILL ASKING — orch inbox`
        : `\n  orch diff ${id}    then score it: ${scoreHint(id, row.job, null)}`,
    )
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
    if (!id) usage()
    const row = db().query(
      `SELECT id, repo, cwd, worktree, branch, branch_kept, base_commit,
              parent_run_id, carry_happened,
              carry_base_commit, carry_tracked_paths, carry_untracked_paths
         FROM run WHERE id = ?`,
    ).get(id) as
      { id: number; repo: string | null; cwd: string | null
        worktree: string | null; branch: string | null
        branch_kept: string | null; base_commit: string | null
        parent_run_id: number | null; carry_happened: number | null
        carry_base_commit: string | null; carry_tracked_paths: string | null
        carry_untracked_paths: string | null } | null
    if (!row) throw new Error(`no run ${id}`)
    if (!row.base_commit) throw new Error(`run ${id} recorded no base commit to diff against`)
    const { changesIn } = await import('./worktree.ts')
    const repoRoot = cleanupRepoRoot(row)
    if (!repoRoot) throw new Error(`run ${id}'s repository root was not found`)
    const worktreePresent = Boolean(row.worktree && existsSync(row.worktree))
    const evidenceBranch = row.branch_kept ?? row.branch
    const branchPresent = Boolean(evidenceBranch && Bun.spawnSync(
      ['git', 'show-ref', '--verify', '--quiet', `refs/heads/${evidenceBranch}`],
      { cwd: repoRoot, env: targetGitEnvironment(repoRoot), stdout: 'ignore', stderr: 'ignore' },
    ).exitCode === 0)
    const discarded = !worktreePresent
    let c: ReturnType<typeof changesIn>
    let commits = ''
    let sinceNote: string
    if (discarded) {
      if (!branchPresent || !evidenceBranch) {
        throw new Error(`run ${id}'s worktree and evidence branch are gone`)
      }
      const project = row.repo ? projectByName(row.repo) : null
      const configuredTrunk = project?.settings.trunk?.trim()
      const trunk = configuredTrunk || 'main'
      let since = row.base_commit
      let usedRecordedFallback = has('since-base')
      if (!has('since-base')) {
        const mergeBase = Bun.spawnSync(['git', 'merge-base', evidenceBranch, trunk], {
          cwd: repoRoot, env: targetGitEnvironment(repoRoot), stdout: 'pipe', stderr: 'pipe',
        })
        if (mergeBase.exitCode === 0) {
          since = mergeBase.stdout.toString().trim()
          usedRecordedFallback = false
        } else if (configuredTrunk) {
          throw new Error(`cannot find merge-base between the run tip and trunk ${trunk}`)
        } else {
          usedRecordedFallback = true
        }
      }
      const diff = Bun.spawnSync(['git', 'diff', '--no-ext-diff', '--binary', since, evidenceBranch], {
        cwd: repoRoot, env: targetGitEnvironment(repoRoot), stdout: 'pipe', stderr: 'pipe',
      })
      if (diff.exitCode !== 0) throw new Error(diff.stderr.toString().trim())
      const names = Bun.spawnSync(['git', 'diff', '--name-only', since, evidenceBranch], {
        cwd: repoRoot, env: targetGitEnvironment(repoRoot), stdout: 'pipe', stderr: 'pipe',
      }).stdout.toString().trim()
      const stat = Bun.spawnSync(['git', 'diff', '--numstat', since, evidenceBranch], {
        cwd: repoRoot, env: targetGitEnvironment(repoRoot), stdout: 'pipe', stderr: 'pipe',
      }).stdout.toString().trim()
      let insertions = 0
      let deletions = 0
      for (const line of stat.split('\n')) {
        const [add, del] = line.split('\t')
        insertions += Number(add) || 0
        deletions += Number(del) || 0
      }
      c = {
        diff: diff.stdout.toString(), files: names ? names.split('\n') : [], insertions, deletions,
        since, trunk, trunkConfigured: Boolean(configuredTrunk),
      }
      const logged = Bun.spawnSync(['git', 'log', '--oneline', `${since}..${evidenceBranch}`], {
        cwd: repoRoot, env: targetGitEnvironment(repoRoot), stdout: 'pipe', stderr: 'pipe',
      })
      commits = logged.exitCode === 0 ? logged.stdout.toString() : ''
      sinceNote = usedRecordedFallback
        ? `${has('since-base') ? 'recorded; --since-base' : 'recorded fallback'}; worktree discarded`
        : `trunk ${trunk}; worktree discarded`
    } else {
      c = changesIn({
        path: row.worktree!,
        branch: row.branch ?? `orch/${id}`,
        base: row.base_commit,
        repoRoot,
      }, has('since-base'))
      const logged = Bun.spawnSync(['git', 'log', '--oneline', `${c.since}..HEAD`], {
        cwd: row.worktree!, env: targetGitEnvironment(row.worktree!), stdout: 'pipe', stderr: 'pipe',
      })
      if (logged.exitCode !== 0) throw new Error(logged.stderr.toString().trim())
      commits = logged.stdout.toString()
      sinceNote = has('since-base')
        ? 'recorded; --since-base'
        : `trunk ${c.trunk}${c.trunkConfigured ? '' : '; register fallback'}`
    }
    const runKind = db().query('SELECT job FROM run WHERE id=?').get(id) as { job: string }
    if (!JOBS[runKind.job]?.needs.writesRepo) {
      console.error(
        `WARNING: run ${id} is a review/read job. Its findings are the product; this diff ` +
        `contains review input and scratch experiments and must not be landed.`,
      )
    }
    // A patch preamble is ignored by `git apply`, while keeping the base in the
    // stdout artefact even under --quiet or when stderr is not captured.
    process.stdout.write(`base: ${row.base_commit} (recorded)\n`)
    process.stdout.write(`since: ${c.since} (${sinceNote})\n`)
    process.stdout.write('commits:\n')
    process.stdout.write(commits || '(none)\n')
    if (row.carry_happened !== null && row.carry_base_commit &&
        row.carry_tracked_paths !== null && row.carry_untracked_paths !== null) {
      const tracked = JSON.parse(row.carry_tracked_paths) as string[]
      const untracked = JSON.parse(row.carry_untracked_paths) as string[]
      process.stdout.write(
        row.carry_happened
          ? `carry: ${tracked.length} tracked path(s), ${untracked.length} untracked path(s)\n` +
            `carry base: ${row.carry_base_commit}\n` +
            tracked.map((path) => `carry tracked: ${JSON.stringify(path)}\n`).join('') +
            untracked.map((path) => `carry untracked: ${JSON.stringify(path)}\n`).join('')
          : `carry: none (0 tracked paths, 0 untracked paths)\ncarry base: ${row.carry_base_commit}\n`,
      )
    }
    // write(), not console.log(): this output is piped into `git apply`, and a
    // newline added to the diff for readability is a byte the patch did not have.
    process.stdout.write(c.diff)
    if (!has('quiet')) {
      console.error(
        `\n— run ${id} · ${c.files.length} file(s) · +${c.insertions}/-${c.deletions}` +
        `\n  base:     ${row.base_commit}` +
        `\n  worktree: ${row.worktree}` +
        // The ROOT owns the worktree. Discarding a child would clear that one
        // row's pointer and leave the root still naming a directory that had
        // just been deleted.
        `\n  discard:  orch discard ${row.parent_run_id ?? id}`,
      )
    }
    break
  }

  /**
   * Delete a writing run's worktree and branch.
   *
   * Never automatic. A failed implementation run leaves the most readable
   * artefact in the system — a partial change set showing exactly how far the
   * worker got — and cleaning up on failure would destroy it at the moment it
   * is most wanted. Throwing the tree away is a decision someone makes after
   * reading the diff.
   *
   * The RUN ROW SURVIVES. Only the checkout goes: the routing evidence, the
   * score and the prompt are what the record is for, and a discarded experiment
   * still happened.
   */
  /**
   * Reclaim worktrees, and the infrastructure behind them, without being asked.
   *
   * A worktree is not a directory here. In these projects it is a database of
   * up to a few gigabytes, a container, a port and a queue worker, and the
   * directory is the cheap part — so worktrees left behind do not merely
   * clutter, they fill the machine with databases nobody can name.
   *
   * Terminal close-out is the normal release event. Sweep is the backstop for
   * a coordinator or session that died before the pairing ran. It applies the
   * same liveness and dirty-work guards; scoring is not a retention signal.
   */
  case 'sweep': {
    await Promise.all([loadJobs(), loadRun(), loadWorktree(), loadGrokTrust(), loadDockerResources()])
    const dry = has('dry-run')
    if (!dry) writableDb()
    const rows = db().query(
      `SELECT r.id, COALESCE(r.parent_run_id, r.id) root_id,
              r.repo, r.worktree, r.branch, r.base_commit, r.worktree_source, r.status, r.job,
              r.keep_tree, r.pid, r.agent_pid, r.session_id, seen.last_seen AS session_last_seen,
              (julianday('now') - julianday(r.started_at)) AS age_days,
              ${EVIDENCE_CLOSED_SQL} AS scored
         FROM run r ${chainScoreJoin('r', 's')}
         LEFT JOIN session_seen seen ON seen.session_id=r.session_id
        WHERE r.worktree IS NOT NULL AND r.status IN ('ok','failed','stale','stopped')
        ORDER BY r.id`,
    ).all() as {
      id: number; root_id: number; repo: string | null; worktree: string
      branch: string | null; base_commit: string | null; status: string
      worktree_source: Worktree['source'] | null
      job: string; keep_tree: number; age_days: number; scored: number
      pid: number | null; agent_pid: number | null; session_id: string | null
      session_last_seen: string | null
    }[]

    const { removeFor, sweepWithTool, orphanSafety,
            isOrchWorktree, markedWorktreeSource, worktreeLatestMtime } =
      await import('./worktree.ts')

    let done = 0
    let cleanupFailed = false
    const inventoryErrors = new Set<string>()
    const leaked = new Map<string, { resource: DockerResource; project: string; runId: number }>()
    const kept: { line: string; reason: string }[] = []
    const keep = (line: string, reason: string) => { kept.push({ line, reason }) }
    for (const r of rows) {
      const current = db().query('SELECT worktree FROM run WHERE id=?').get(r.id) as
        { worktree: string | null } | null
      if (current?.worktree !== r.worktree) continue
      if (!dry) {
        const before = resourcesForConversation(r.id)
        for (const error of before.errors) inventoryErrors.add(error)
        if (before.errors.length) {
          cleanupFailed = true
          keep(`${r.id}  inventory unavailable`, 'inventory unavailable')
          console.error(`could not verify reclaim ${r.id}: inventory unavailable`)
          continue
        }
      }
      const closed = closeOutRun(r.id, { sweep: true, dryRun: dry })
      if (closed.outcome === 'released' || closed.outcome === 'absent') {
        if (dry) {
          console.log(`would reclaim ${r.id}  ${r.worktree}`)
          done++
        } else {
          const project = r.repo ?? projectAt(r.worktree)?.name ?? 'unknown'
          const inventory = resourcesForConversation(r.id)
          for (const error of inventory.errors) inventoryErrors.add(error)
          if (inventory.errors.length) {
            cleanupFailed = true
            keep(`${r.id}  inventory unavailable`, 'inventory unavailable')
            console.error(`could not verify reclaim ${r.id}: inventory unavailable`)
          } else if (inventory.resources.length) {
            cleanupFailed = true
            for (const resource of inventory.resources) leaked.set(`${resource.kind}:${resource.name}`, {
              resource, project, runId: r.id,
            })
            keep(`${r.id}  leaked Docker resources`, 'leaked Docker resources')
            console.error(`could not fully reclaim ${r.id}: project ${project}'s remove tool leaked Docker resources`)
          } else {
            writeTransaction(() => {
              auditRunMutation(
                { runId: r.id, rootId: r.root_id, owner: null, actor: sessionId() },
                'sweep',
              )
            })
            console.log(`reclaimed ${r.id}  ${r.worktree}`)
            done++
          }
        }
      } else {
        const reason = closed.detail.startsWith('held by explicit --keep-tree')
          ? 'held by explicit --keep-tree; clear with orch discard <run-id>'
          : closed.detail
        keep(`${r.id}  ${closed.outcome}: ${closed.detail}`, reason)
        if (closed.outcome === 'failed') {
          cleanupFailed = true
          console.error(`could not reclaim ${r.id}: ${closed.detail}`)
        }
      }
    }

    /**
     * DATABASE ROWS ARE NOT AN INVENTORY OF WHAT IS ON DISK.
     *
     * A worktree whose row never acquired its path is invisible to the loop
     * above and would otherwise leak forever. Orphans are discovered from each
     * registered project's conventional worktree root, then held to a stricter
     * standard than remembered trees: their filesystem work must be committed
     * to the branch. A failed proof keeps the directory, and a
     * project's own removal refusal remains final through removeWithTool().
     */
    const remembered = new Set(
      (db().query('SELECT worktree FROM run WHERE worktree IS NOT NULL').all() as { worktree: string }[])
        .map((r) => existsSync(r.worktree) ? realpathSync(r.worktree) : r.worktree),
    )
    for (const p of projects()) {
      const root = join(p.path, '.claude', 'worktrees')
      if (!existsSync(root)) continue
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const path = join(root, entry.name)
        if (remembered.has(realpathSync(path))) continue

        const label = `orphan  ${path}`
        if (!isOrchWorktree(path, p.settings.worktree?.branch)) {
          keep(`${label}  kept: not created by orch`, 'not created by orch')
          continue
        }
        const named = namedRun(entry.name, p.settings.worktree?.branch, p)
        if (named?.status === 'running' || named?.status === 'asking') {
          keep(`${label}  live — kept`, 'live — kept')
          continue
        }
        const latest = worktreeLatestMtime(path)
        if (latest !== null && latest > Date.now() - 2 * 60 * 60 * 1000) {
          keep(`${label}  live — files changed inside 2h`, 'live — recent filesystem activity')
          continue
        }
        const trunk = typeof p.settings.trunk === 'string' && p.settings.trunk.trim()
          ? p.settings.trunk : 'HEAD'
        const safe = orphanSafety(path, p.path, trunk)
        if (!safe.removable) {
          keep(`${label}  ${safe.detail}`, orphanKeepReason(safe.detail))
          continue
        }
        if (dry) {
          console.log(`would reclaim ${label}; ${safe.detail}`)
          done++
          continue
        }

        const source = markedWorktreeSource(path)
        const w = {
          path, branch: safe.branch, base: '', repoRoot: p.path,
          source, mintedBranch: safe.branch,
        }
        const runId = orchRunId(entry.name)
        try {
          withCleanupLock(p.path, `sweep ${label}`, path, () => {
            const ownerRow = { id: runId ?? -1, repo: p.name, branch: safe.branch }
            const worktreeRow = { id: runId ?? -1, worktree: path }
            const sharersBefore = evidenceOwningWorktreeSharers(db(), worktreeRow)
            if (sharersBefore.length) {
              const owners = sharersBefore.map((owner) =>
                `${owner.id} (${owner.status})`).join(', ')
              cleanupFailed = true
              keep(`${label}  acquired by run(s): ${owners}`, 'shared with live run(s)')
              console.error(`could not reclaim ${label}: acquired by run(s) ${owners}`)
              return
            }
            const ownersBefore = evidenceOwningBranchOwners(ownerRow, p.path)
            const snapshot = safe.branch ? branchTip(p.path, safe.branch) : null
            const lockedRun = namedRun(entry.name, p.settings.worktree?.branch, p)
            if (lockedRun?.status === 'running' || lockedRun?.status === 'asking') {
              keep(`${label}  live — kept`, 'live — kept')
              return
            }
            const res = removeFor(w, p.path, false, ownersBefore.length > 0, runId ?? undefined)
            const sharersAfter = evidenceOwningWorktreeSharers(db(), worktreeRow)
            const ownersAfter = evidenceOwningBranchOwners(ownerRow, p.path, snapshot)
            if (safe.branch) {
              const outcome = verifyBranchOwnershipAfterCleanup(
                runId ?? -1, p.path, safe.branch, snapshot, ownersBefore, ownersAfter,
              )
              if (outcome.warning) console.error(`${label}: ${outcome.warning}`)
              if (outcome.refusal) {
                cleanupFailed = true
                keep(`${label}  removal refused`, 'removal refused')
                console.error(`could not reclaim ${label}: ${outcome.refusal}`)
                return
              }
            }
            if (sharersAfter.length) {
              const owners = sharersAfter.map((owner) =>
                `${owner.id} (${owner.status})`).join(', ')
              cleanupFailed = true
              keep(`${label}  acquired during cleanup by run(s): ${owners}`,
                'shared with live run(s)')
              console.error(`could not reclaim ${label}: acquired during cleanup by run(s) ${owners}`)
              return
            }
            if (res.removed) {
              const inventory = runId === null
                ? { resources: [], errors: [] }
                : resourcesForConversation(runId)
              for (const error of inventory.errors) inventoryErrors.add(error)
              if (inventory.errors.length) {
                cleanupFailed = true
                keep(`${label}  inventory unavailable`, 'inventory unavailable')
                return
              }
              const left = inventory.resources
              if (left.length) {
                cleanupFailed = true
                for (const resource of left) leaked.set(`${resource.kind}:${resource.name}`, {
                  resource, project: p.name, runId: resource.runId,
                })
                keep(`${label}  leaked Docker resources`, 'leaked Docker resources')
              } else {
                console.log(`reclaimed ${label}  ${res.detail}`)
                if (res.output) console.log(res.output)
                const owner = ownersAfter[0] ?? ownersBefore[0] ?? null
                if (owner && safe.branch) {
                  console.log(`branch ${safe.branch} left because run ${owner.id} records it`)
                }
                done++
              }
            } else {
              cleanupFailed = true
              keep(`${label}  removal refused`, 'removal refused')
              console.error(`could not reclaim ${label}: ${res.detail}`)
            }
          })
        } catch (error) {
          cleanupFailed = true
          keep(`${label}  removal refused`, 'removal refused')
          console.error(
            `could not reclaim ${label}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }

    /**
     * Then the PROJECT'S OWN sweep, which knows what orch cannot.
     *
     * A database whose worktree directory was deleted by hand is invisible to
     * everything above — no row points at it, and there is nothing left to
     * remove. Each project's tool is the only thing that can find those, and
     * running it is the difference between reclaiming directories and
     * reclaiming disk.
     */
    if (!dry) {
      for (const p of (await import('./projects.ts')).projects()) {
        const tool = p.settings.worktree
        if (!tool?.sweep) continue
        let result: ReturnType<typeof sweepWithTool>
        try {
          result = withCleanupLock(p.path, `project sweep for ${p.name}`, null, () =>
            sweepWithTool(tool, p.path))
        } catch (error) {
          cleanupFailed = true
          console.error(
            `project ${p.name} sweep failed: ${error instanceof Error ? error.message : String(error)}`,
          )
          continue
        }
        if (!result) continue
        if (result.out.trim()) {
          const lines = result.out.trim().split('\n')
          const omitted = Math.max(0, lines.length - 8)
          console.log(`\n${p.name} sweep:\n${lines.slice(-8).join('\n')}`)
          if (omitted) {
            console.log(`  (${omitted} earlier line${omitted === 1 ? '' : 's'} omitted)`)
          }
        }
        if (!result.ok) {
          cleanupFailed = true
          console.error(
            `project ${p.name} sweep failed with exit status ${result.exitCode ?? 'unknown'}`,
          )
        }
      }
    }

    const trustRuns = db().query(
      'SELECT id, mcp_trust_path FROM run WHERE mcp_trust_path IS NOT NULL ORDER BY id',
    ).all() as { id: number; mcp_trust_path: string }[]
    const trustOwners = new Map<string, number>()
    for (const run of trustRuns) {
      try {
        const headings = JSON.parse(run.mcp_trust_path) as unknown
        if (!Array.isArray(headings)) continue
        for (const heading of headings) {
          if (typeof heading === 'string' && !trustOwners.has(heading)) {
            trustOwners.set(heading, run.id)
          }
        }
      } catch { /* observation from an older or incomplete row is not authority */ }
    }
    for (const heading of grokTrustHeadings()) {
      const path = grokTrustPathFromHeading(heading)
      if (!path || existsSync(path)) continue
      const runId = trustOwners.get(heading)
      console.log(
        `grok trust entry for absent path ${path}${runId ? ` (run ${runId})` : ''}; prune by hand`,
      )
    }

    // Inventory is a read, so dry-run performs it too. A preview that omits
    // already-leaked infrastructure is materially cleaner than the real run.
    const inventory = dockerRunResources()
    for (const error of inventory.errors) inventoryErrors.add(error)
    if (inventory.errors.length) cleanupFailed = true
    const inventoryOwnerIds = new Set(inventory.resources.map(({ runId }) => runId))
    const owners = (db().query('SELECT id, repo, worktree, status FROM run').all() as {
      id: number; repo: string | null; worktree: string | null; status: string
    }[]).map((owner) => ({
      ...owner,
      retentionReason: inventoryOwnerIds.has(owner.id)
        ? terminalDockerRetentionReasonForRun(db(), owner.id)
        : null,
    }))
    const classified = classifiedDockerResources(inventory.resources, owners)
    for (const { resource, project, condition } of classified) {
      if (condition === 'retained-worktree-resources') continue
      const key = `${resource.kind}:${resource.name}`
      if (!leaked.has(key)) leaked.set(key, { resource, project, runId: resource.runId })
    }
    const retained = classified.filter(({ condition }) => condition === 'retained-worktree-resources')
    if (retained.length) {
      console.error(`\n${dry ? 'would report ' : ''}retained worktree Docker resources: ${retained.length}`)
      for (const { resource, project, reason } of retained) {
        console.error(`  ${resource.kind} ${resource.name} re-served or retained by project ${project} (run ${resource.runId}); ${reason ? `removal could not be ascertained: ${reason}; ` : ''}no removal suggested`)
      }
    }
    if (leaked.size) {
      cleanupFailed = true
      console.error(`\n${dry ? 'would report ' : ''}leaked Docker resources: ${leaked.size}`)
      for (const { resource, project } of leaked.values()) {
        console.error(`  ${dry ? 'would report ' : ''}${leakedResourceLines([resource], project)[0]}`)
      }
    }
    if (inventoryErrors.size) {
      console.error(`\n${dry ? 'would report ' : ''}inventory unavailable: ${inventoryErrors.size}`)
      for (const error of inventoryErrors) console.error(`  ${dry ? 'would report ' : ''}${error}`)
    }

    printSweepKept(done, kept, dry)
    if (cleanupFailed) process.exitCode = 1
    break
  }

  case 'discard': {
    await Promise.all([loadWorktree(), loadDockerResources()])
    const id = Number(argv[1])
    if (!id) usage()
    let authority = authorizeRunMutation(id, 'discard')
    const rootRow = db().query(
      `SELECT id, repo, cwd, worktree, branch, branch_kept, branch_kept_tip, base_commit,
              worktree_source
         FROM run WHERE id = ?`,
    ).get(authority.rootId) as {
      id: number; repo: string | null; cwd: string | null; worktree: string | null
      branch: string | null; branch_kept: string | null; branch_kept_tip: string | null
      base_commit: string | null
      worktree_source: Worktree['source'] | null
    } | null
    if (!rootRow) throw new Error(`no run ${authority.rootId}`)
    const chain = db().query(
      `SELECT id, status, worktree, branch, base_commit, worktree_source FROM run
        WHERE id = ? OR parent_run_id = ? ORDER BY turn, id`,
    ).all(authority.rootId, authority.rootId) as {
      id: number; status: string; worktree: string | null; branch: string | null; base_commit: string | null
      worktree_source: Worktree['source'] | null
    }[]
    const worktrees = [...new Set(chain.flatMap((turn) => turn.worktree ? [turn.worktree] : []))]
    if (worktrees.length > 1) {
      const live = chain.filter((turn) => turn.worktree && ['running', 'asking'].includes(turn.status))
      if (live.length) {
        throw new Error(
          `refusing to discard chain ${authority.rootId}: live turns still own worktrees:\n` +
          live.map((turn) => `  run ${turn.id} (${turn.status}): ${turn.worktree}`).join('\n'),
        )
      }
      for (const worktree of worktrees) {
        const artifact = chain.find((turn) => turn.worktree === worktree)!
        discardWorktree({
          id: authority.rootId, repo: rootRow.repo, cwd: rootRow.cwd, worktree,
          branch: artifact.branch ?? rootRow.branch,
          base_commit: artifact.base_commit ?? rootRow.base_commit,
          worktree_source: artifact.worktree_source ?? rootRow.worktree_source,
        }, 'discarded', has('force'), authority)
      }
      break
    }
    const artifact = chain.find((turn) => turn.worktree === worktrees[0])
    const row = {
      ...rootRow,
      worktree: worktrees[0] ?? null,
      branch: rootRow.branch ?? artifact?.branch ?? null,
      base_commit: rootRow.base_commit ?? artifact?.base_commit ?? null,
      worktree_source: rootRow.worktree_source ?? artifact?.worktree_source ?? null,
    }
    if (!row.worktree) {
      if (!has('force') || !row.branch_kept) {
        throw new Error(`run ${id} has no worktree to discard`)
      }
      const repoRoot = cleanupRepoRoot(row)
      if (!repoRoot) throw new Error(`run ${id}'s repository root was not found`)
      withCleanupLock(repoRoot, `discard kept branch for run ${id}`, null, () => {
        const ownerRow = { id: row.id, repo: row.repo, branch: row.branch_kept }
        const ownersBefore = evidenceOwningBranchOwners(ownerRow, repoRoot)
        if (ownersBefore.length) {
          throw new Error(
            `branch ${row.branch_kept} is still evidence owned by run ${ownersBefore[0]!.id}; ` +
            'it was left in place',
          )
        }
        authority = adoptRunMutation(authority, 'discard')
        const snapshot = branchTip(repoRoot, row.branch_kept!)
        const removed = removeBranch(repoRoot, row.branch_kept!)
        const ownersAfter = evidenceOwningBranchOwners(ownerRow, repoRoot, snapshot)
        const outcome = verifyBranchOwnershipAfterCleanup(
          row.id, repoRoot, row.branch_kept!, snapshot, ownersBefore, ownersAfter,
        )
        if (outcome.refusal) throw new Error(outcome.refusal)
        if (outcome.warning) console.error(outcome.warning)
        if (removed) {
          writeTransaction(() => {
            db().query('UPDATE run SET branch_kept=NULL, branch_kept_tip=NULL WHERE id=?')
              .run(authority.rootId)
            auditRunMutation(authority, 'discard', auditReason())
          })
        }
        console.log(removed
          ? `deleted branch ${row.branch_kept}`
          : `branch ${row.branch_kept} cleanup skipped: branch does not exist`)
      })
      break
    }

    await discardWorktree(row as CleanupRow, 'discarded', has('force'), authority)
    break
  }

  case 'close-out': {
    await loadRun()
    const id = Number(argv[1])
    if (!id) usage()
    writableDb()
    const result = closeOutRun(id)
    console.log(`${result.outcome} run ${result.runId}${result.worktree ? ` ${result.worktree}` : ''}: ${result.detail}`)
    if (result.outcome === 'held' || result.outcome === 'failed') process.exitCode = 1
    break
  }

  case 'stop': {
    await Promise.all([loadRun(), loadWorktree(), loadDockerResources()])
    const id = Number(argv[1])
    if (!id) usage()
    let authority = authorizeRunMutation(id, 'stop')
    lifecycleCheckpoint('stop-before-immediate')
    type StopRow = {
      id: number; status: string; pid: number | null; agent_pid: number | null
      parent_run_id: number | null; turn: number; repo: string | null; cwd: string | null
      worktree: string | null; branch: string | null; base_commit: string | null
      worktree_source: Worktree['source'] | null
    }
    const readChain = () => db().query(
      `SELECT id, status, pid, agent_pid, parent_run_id, turn, repo, cwd, worktree, branch,
              base_commit, worktree_source
         FROM run WHERE id = ? OR parent_run_id = ? ORDER BY turn DESC, id DESC`,
    ).all(authority.rootId, authority.rootId) as StopRow[]
    const describe = (chain: StopRow[]) => [...chain].reverse()
      .map((turn) => `${turn.id} turn ${turn.turn} ${turn.status}`).join('; ')

    const stopped = writeTransaction(() => {
      const chain = readChain()
      const row = chain.find((turn) => turn.status === 'running')
      if (!row) {
        throw new Error(
          `run ${id}'s chain has no running turn — nothing to stop: ${describe(chain)}`,
        )
      }
      const root = chain.find((turn) => turn.id === authority.rootId)!
      const artifact = chain.find((turn) => turn.worktree)
      const cleanupRow = {
        ...root,
        worktree: row.worktree ?? artifact?.worktree ?? null,
        branch: root.branch ?? row.branch ?? artifact?.branch ?? null,
        base_commit: root.base_commit ?? row.base_commit ?? artifact?.base_commit ?? null,
        worktree_source: root.worktree_source ?? row.worktree_source ?? artifact?.worktree_source ?? null,
      }

      authority = adoptRunMutation(authority, 'stop')
      const changed = db().query(
        "UPDATE run SET status='stopped', error='stopped by architect', failure_kind='stopped' WHERE id=? AND status='running'",
      ).run(row.id)
      if (changed.changes !== 1) {
        const current = readChain()
        throw new Error(
          `run ${id}'s chain changed before it could be stopped: ${describe(current)}`,
        )
      }
      if (row.id !== authority.rootId) {
        db().query(
          "UPDATE run SET status='stopped', error='stopped by architect', failure_kind='stopped' WHERE id=?",
        ).run(authority.rootId)
      }
      db().query(
        `UPDATE question SET delivery_pending_at=NULL
          WHERE run_id IN (SELECT id FROM run WHERE id=? OR parent_run_id=?)`,
      ).run(authority.rootId, authority.rootId)
      auditRunMutation(authority, 'stop', auditReason())
      return { row, cleanupRow }
    })
    const { row, cleanupRow } = stopped

    const pids = [...new Set([row.agent_pid, row.pid].filter((pid): pid is number => Boolean(pid)))]
    for (const pid of pids) {
      try { process.kill(pid, 0) } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
      }
    }

    // The coordinator owns setup and final recording. Killing it inside the
    // creation window strands the project tool's directory before it can be
    // attributed or reclaimed. Stop the vendor, but let the coordinator see
    // the stopped row and finish recording. The tree remains the continuation
    // substrate; only its recreatable containers are reclaimed at stop.
    terminateRunProcesses(row.id, row.pid ? [row.pid] : [])
    const dockerTeardown = teardownTerminalRunResources(db(), row.id)
    console.log(`stopped run ${row.id}`)
    if (cleanupRow.worktree) {
      const dockerMessage = !dockerTeardown.complete
        ? dockerTeardown.removed
          ? 'reclaimed Docker containers, but reclamation was incomplete'
          : 'Docker container reclamation was incomplete'
        : dockerTeardown.outcome === 'removed'
          ? 'reclaimed Docker containers'
          : dockerTeardown.outcome === 'live-sibling'
            ? 'left Docker containers in place because another live run still owns the tree'
            : dockerTeardown.outcome === 'unascertainable'
              ? `left Docker containers in place because removal could not be ascertained: ${dockerTeardown.reason}`
            : 'found no Docker containers to reclaim'
      console.log(
        `kept worktree ${cleanupRow.worktree} and branch ${cleanupRow.branch ?? '(unknown)'} for continuation; ` +
        dockerMessage,
      )
    } else if (dockerTeardown.outcome === 'unascertainable') {
      console.log(
        `left Docker containers in place because removal could not be ascertained: ${dockerTeardown.reason}`,
      )
    }
    break
  }

  case 'abandon': {
    await Promise.all([loadRun(), loadWorktree(), loadDockerResources()])
    const id = Number(argv[1])
    if (!id) usage()
    let authority = authorizeRunMutation(id, 'abandon')
    lifecycleCheckpoint('abandon-before-immediate')
    type AbandonRow = {
      id: number; status: string; repo: string | null; cwd: string | null
      worktree: string | null; branch: string | null; parent_run_id: number | null; turn: number
      base_commit: string | null
      worktree_source: Worktree['source'] | null
    }
    const callerSession = authority.actor
    const note = flag('note')
    const error = `abandoned by architect${note === undefined ? '' : `: ${note}`}`
    const at = nowIso()
    const readChain = () => db().query(
      `SELECT id, status, repo, cwd, worktree, branch, parent_run_id, turn, base_commit,
              worktree_source
         FROM run WHERE id = ? OR parent_run_id = ? ORDER BY turn DESC, id DESC`,
    ).all(authority.rootId, authority.rootId) as AbandonRow[]
    const describe = (chain: AbandonRow[]) => [...chain].reverse()
      .map((turn) => `${turn.id} turn ${turn.turn} ${turn.status}`).join('; ')

    const abandoned = writeTransaction(() => {
      const chain = readChain()
      const row = chain[0]
      if (row?.status !== 'asking') {
        throw new Error(
          `run ${id}'s chain has no asking turn — nothing to abandon: ${describe(chain)}`,
        )
      }
      const root = chain.find((turn) => turn.id === authority.rootId)!
      const artifact = chain.find((turn) => turn.worktree)
      const cleanupRow = {
        ...root,
        worktree: row.worktree ?? artifact?.worktree ?? null,
        branch: root.branch ?? row.branch ?? artifact?.branch ?? null,
        base_commit: root.base_commit ?? row.base_commit ?? artifact?.base_commit ?? null,
        worktree_source: root.worktree_source ?? row.worktree_source ?? artifact?.worktree_source ?? null,
      }
      authority = adoptRunMutation(authority, 'abandon')
      const changed = db().query(
        "UPDATE run SET status='stale', error=?, failure_kind='abandoned' WHERE id=? AND status='asking'",
      ).run(error, row.id)
      if (changed.changes !== 1) {
        const current = readChain()
        throw new Error(
          `run ${id}'s chain changed before it could be abandoned: ${describe(current)}`,
        )
      }
      db().query(
        `UPDATE question SET answered_by=?, answered_at=?, answer='(abandoned)', delivery_pending_at=NULL
          WHERE answered_at IS NULL AND run_id IN
            (SELECT id FROM run WHERE id=? OR parent_run_id=?)`,
      ).run(callerSession ?? 'anonymous (no session id)', at, authority.rootId, authority.rootId)
      db().query(
        `UPDATE question SET delivery_pending_at=NULL
          WHERE run_id IN (SELECT id FROM run WHERE id=? OR parent_run_id=?)`,
      ).run(authority.rootId, authority.rootId)
      resolveRootFromLastTurn(db(), authority.rootId)
      auditRunMutation(authority, 'abandon', note ?? null)
      return { row, cleanupRow }
    })
    const { row } = abandoned
    console.log(`abandoned run ${row.id}`)

    const closed = closeOutRun(authority.rootId, { terminalAt: Date.now() })
    console.log(`${closed.outcome} worktree: ${closed.detail}`)
    if (closed.outcome === 'failed') process.exitCode = 1
    break
  }

  case 'judge': {
    await Promise.all([loadJobs(), loadReview(), loadWorktree(), loadDockerResources()])
    writableDb()
    const requestedId = Number(argv[1])
    if (!requestedId) usage()
    const row = db().query(
      `SELECT root.id, root.agent, root.job, root.status, root.session_id, root.failure_kind,
              root.output_path, root.repo, root.cwd, root.worktree, root.branch, root.base_commit,
              root.worktree_source
         FROM run requested
         JOIN run root ON root.id = COALESCE(requested.parent_run_id, requested.id)
        WHERE requested.id=?`,
    ).get(requestedId) as {
      id: number; agent: string; job: string; status: string; session_id: string | null
      failure_kind: FailureKind | null; output_path: string | null; repo: string | null
      cwd: string | null; worktree: string | null; branch: string | null
      base_commit: string | null; worktree_source: Worktree['source'] | null
    } | null
    if (!row) throw new Error(`no run ${requestedId}`)
    const id = row.id
    if (['running', 'asking'].includes(row.status)) {
      throw new Error(`run ${id} is ${row.status}, not terminal`)
    }
    if (row.agent === '(pending)') throw new Error(`run ${id} cannot be judged: no agent was selected`)
    if (row.failure_kind === 'unevidenced' ||
        (row.failure_kind && NOT_EVIDENCE.includes(row.failure_kind))) {
      throw new Error(`run ${id} cannot be judged: failure kind '${row.failure_kind}' is not evidence`)
    }
    const owner = judgeability(row.session_id, sessionId())
    if (!has('force') && owner.verdict === 'foreign') {
      throw new Error(`run ${id} was made by another session (${owner.owner}); --force overrides`)
    }
    if (!has('force') && owner.verdict === 'anonymous') {
      throw new Error(`run ${id} belongs to session ${owner.owner}, but no session identity is present; --force overrides`)
    }
    if (!has('force') && owner.verdict === 'unattributed' && !sessionId()) {
      throw new Error(`run ${id} is unowned; CLAUDE_CODE_SESSION_ID is not set`)
    }

    const words = argv.slice(2).filter(
      (a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv.slice(2)[i - 1] ?? ''),
    )
    const delivery = words[0] as Delivery | undefined
    const quality = words[1] as Quality | undefined
    const fidelity = words[2] as Fidelity | undefined
    const missing: string[] = []
    if (!delivery) missing.push(`<${DELIVERY.join('|')}>`)
    else if (!DELIVERY.includes(delivery)) {
      throw new Error(`delivery must be: ${DELIVERY.join(' | ')}`)
    }
    if (delivery === 'none' && quality) throw new Error("delivery 'none' takes no quality")
    if (delivery !== 'none' && !quality) missing.push(`<${QUALITY.join('|')}>`)
    else if (quality && !QUALITY.includes(quality)) {
      throw new Error(`quality must be: ${QUALITY.join(' | ')}`)
    }
    const writes = Boolean(JOBS[row.job]?.needs.writesRepo)
    if (writes && delivery !== 'none' && !fidelity) missing.push(`<${FIDELITY.join('|')}>`)
    else if (fidelity && !FIDELITY.includes(fidelity)) {
      throw new Error(`fidelity must be: ${FIDELITY.join(' | ')}`)
    }
    if (!writes && fidelity) throw new Error(`${row.job} is judged on two axes only`)

    const findingsJob = Boolean(job(row.job).findings)
    const gradeNames = ['reproduced', 'coverage', 'limits', 'overlap'] as const
    const suppliedGrades = {
      reproduced: flag('reproduced'), coverage: flag('coverage'),
      limits: flag('limits'), overlap: flag('overlap'),
    }
    const validGrades = {
      reproduced: REVIEW_REPRODUCED, coverage: REVIEW_COVERAGE,
      limits: REVIEW_LIMITS, overlap: REVIEW_OVERLAP,
    } as const
    for (const name of gradeNames) {
      const value = suppliedGrades[name]
      if (value !== undefined && !(validGrades[name] as readonly string[]).includes(value)) {
        throw new Error(`--${name} must be: ${validGrades[name].join(' | ')}`)
      }
    }
    let parsedOutput: ReturnType<typeof parseReviewOutput> = null
    let reviewId: number | null = null
    let storedGrades: Partial<Record<typeof gradeNames[number], string>> = {}
    let reviewFindings: { ordinal: number; disposition: string | null }[] = []
    if (findingsJob) {
      const lens = db().query(
        'SELECT review_id, reproduced, coverage, limits, overlap FROM review_lens WHERE run_id=?',
      ).get(id) as ({ review_id: number } & Record<typeof gradeNames[number], string | null>) | null
      reviewId = lens?.review_id ?? null
      if (delivery !== 'none' && !reviewId) {
        if (row.output_path && existsSync(row.output_path)) {
          parsedOutput = parseReviewOutput(readFileSync(row.output_path, 'utf8'))
        }
        if (!parsedOutput) throw new Error(`run ${id} has no recorded review; recover it with orch review record ${id}`)
      } else if (delivery !== 'none') {
        storedGrades = Object.fromEntries(
          gradeNames.flatMap((name) => lens?.[name] ? [[name, lens[name]]] : []),
        )
        reviewFindings = db().query(
          'SELECT ordinal, disposition FROM review_finding WHERE review_id=? ORDER BY ordinal',
        ).all(reviewId) as { ordinal: number; disposition: string | null }[]
      }
    }
    const gradeValues = Object.fromEntries(gradeNames.map((name) => [
      name, suppliedGrades[name] ?? storedGrades[name],
    ])) as Record<typeof gradeNames[number], string | undefined>

    const parsedFindings = flags('finding').map((value) => {
      const matched = value.match(/^(\d+)=(accepted|modified|rejected|skipped):(.+)$/)
      if (!matched) {
        throw new Error(
          `bad --finding ${JSON.stringify(value)}; use N=accepted:high or N=rejected:below-bar`,
        )
      }
      const ordinal = Number(matched[1])
      const disposition = matched[2] as Disposition
      const detail = matched[3]!
      if (disposition !== 'rejected' && !REVIEW_SEVERITY.includes(detail as any)) {
        throw new Error(`finding ${ordinal} severity must be: ${REVIEW_SEVERITY.join(' | ')}`)
      }
      return {
        ordinal, disposition,
        category: disposition === 'rejected' ? detail : undefined,
        severity: disposition === 'rejected' ? undefined : detail,
      }
    })
    if (new Set(parsedFindings.map((finding) => finding.ordinal)).size !== parsedFindings.length) {
      throw new Error('--finding names the same finding more than once')
    }

    const partners = pairPartners(id, sessionId())
    const comparisonNames = ['better-than', 'worse-than', 'same-as'] as const
    const suppliedComparisons = comparisonNames.filter((name) => flag(name) !== undefined)
    if (suppliedComparisons.length > 1) {
      throw new Error('--better-than, --worse-than, and --same-as are mutually exclusive')
    }
    const comparison = suppliedComparisons[0]
    const comparisonIds = comparison ? parseRunIds(flag(comparison)!, `--${comparison}`) : []

    if (findingsJob && delivery !== 'none') {
      for (const name of gradeNames) if (!gradeValues[name]) missing.push(`--${name}`)
      const allowed = reviewId ? reviewFindings.map((finding) => finding.ordinal)
        : parsedOutput!.findings.map((_, index) => index + 1)
      const expected = reviewId ? reviewFindings.filter((finding) => finding.disposition === null)
        .map((finding) => finding.ordinal) : allowed
      for (const ordinal of expected) {
        if (!parsedFindings.some((finding) => finding.ordinal === ordinal)) {
          missing.push(`--finding ${ordinal}=<disposition>:<severity-or-category>`)
        }
      }
      const unexpected = parsedFindings.find((finding) => !allowed.includes(finding.ordinal))
      if (unexpected) throw new Error(`review for run ${id} has no finding ${unexpected.ordinal}`)
    } else if (parsedFindings.length || gradeNames.some((name) => suppliedGrades[name])) {
      throw new Error(`${row.job} does not take findings close-out flags`)
    }
    if (partners.length && !comparison) {
      missing.push(
        `--better-than ${partners.map((partner) => partner.id).join(',')} | ` +
        `--worse-than ${partners.map((partner) => partner.id).join(',')} | ` +
        `--same-as ${partners.map((partner) => partner.id).join(',')}`,
      )
    }
    if (comparison) {
      const expected = partners.map((partner) => partner.id).sort((a, b) => a - b)
      const actual = [...comparisonIds].sort((a, b) => a - b)
      if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
        throw new Error(
          `pair verdict must name every comparable partner: ${expected.join(', ') || 'none'}`,
        )
      }
    }
    if (missing.length) {
      throw new Error(`orch judge ${id} is missing:\n${missing.map((item) => `  ${item}`).join('\n')}`)
    }

    const note = scoreNote()
    let authority = runMutationActor(id)
    const scoredAt = nowIso()
    const wasScored = Boolean(db().query('SELECT 1 FROM score WHERE run_id=?').get(id))
    writeTransaction(() => {
      if (!(has('force') && !authority.actor)) authority = adoptRunMutation(authority, 'score')
      if (findingsJob && delivery !== 'none') {
        reviewId = gradeReviewLens(id, parsedOutput, gradeValues as ReviewGrades)
      }
      db().query(
        `INSERT INTO score (run_id, delivery, quality, fidelity, note, scored_at, scored_by)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(run_id) DO UPDATE SET delivery=excluded.delivery, quality=excluded.quality,
           fidelity=excluded.fidelity,
           note=CASE
             WHEN score.note IS NULL OR trim(score.note) = '' THEN excluded.note
             WHEN excluded.note IS NULL OR trim(excluded.note) = '' THEN score.note
             ELSE score.note || '\n\n--- re-scored ' || excluded.scored_at || ' ---\n' || excluded.note
           END,
           scored_at=excluded.scored_at`,
      ).run(id, delivery!, quality ?? null,
        writes && delivery !== 'none' ? fidelity ?? null : null, note, scoredAt,
        process.env.ORCH_SCORER ?? 'claude')
      if (reviewId) {
        if (delivery === 'none') {
          db().query('UPDATE review SET completed_at=? WHERE id=?').run(scoredAt, reviewId)
        } else {
          for (const finding of parsedFindings) {
            triageFinding(
              reviewId, finding.ordinal, finding.disposition, finding.category, finding.severity,
            )
          }
          completeReview(reviewId)
        }
      }
      if (comparison === 'better-than') recordDuels(id, comparisonIds, sessionId(), scoredAt, has('force'))
      if (comparison === 'worse-than') recordLosses(id, comparisonIds, sessionId(), scoredAt, has('force'))
      if (comparison === 'same-as') recordTies(id, comparisonIds, sessionId(), scoredAt, has('force'))
      auditRunMutation(authority, wasScored ? 'rescore' : 'score', auditReason())
    })
    console.log(`judged run ${id}: score${reviewId ? `, completed review ${reviewId}` : ''}` +
      `${comparison ? ', pair recorded' : ''}`)

    if (has('discard')) {
      if (!row.worktree) throw new Error(`run ${id} has no worktree to discard`)
      const discardAuthority = authorizeRunMutation(id, 'discard')
      discardWorktree(row as CleanupRow, 'discarded', false, discardAuthority)
    }
    break
  }

  case 'score': {
    await Promise.all([loadJobs(), loadAgents(), loadRoute(), loadReview()])
    writableDb()
    const note = scoreNote()
    const requestedId = Number(argv[1])
    if (!requestedId) usage()
    const row = db().query(
      `SELECT root.id, root.agent, root.job, root.session_id, root.parent_run_id,
              root.failure_kind, root.output_path
         FROM run requested
         JOIN run root ON root.id = COALESCE(requested.parent_run_id, requested.id)
        WHERE requested.id = ?`,
    ).get(requestedId) as
      | { id: number; agent: string; job: string; session_id: string | null
          parent_run_id: number | null; failure_kind: FailureKind | null; output_path: string | null } | null
    if (!row) throw new Error(`no run ${requestedId}`)
    const id = row.id
    // A pick-time harness refusal never selected an agent, but it is still a
    // real failed row the owning session must be able to clear from its ledger.
    // Voiding that one shape records the note without manufacturing evidence.
    if (row.agent === '(pending)' && !(has('void') && row.failure_kind === 'harness')) {
      throw new Error(`run ${id} cannot be scored: its agent is the placeholder '(pending)'`)
    }
    const scorer = flag('scorer')
    const dashboardAuthorized = dashboardScoreAuthorized(scorer)
    let scoreAuthority = runMutationActor(id)
    const owner = judgeability(row.session_id, sessionId())
    let voidAuthority: RootAuthority | null = null
    if (has('void')) {
      voidAuthority = authorizeRunMutation(id, 'void')
    } else if (!dashboardAuthorized && !has('force') && !sessionId() && owner.verdict === 'unattributed') {
      throw new Error(`run ${id} is unowned; CLAUDE_CODE_SESSION_ID is not set`)
    } else if ((owner.verdict === 'foreign' || owner.verdict === 'anonymous') &&
               !has('force') && !dashboardAuthorized) {
      throw new Error(
        `run ${id} was made by another session — ownership is not established.\n` +
          `  its session:   ${owner.owner}\n` +
          `  your session:  ${sessionId() ?? 'no session identity is present'}\n\n` +
          `Scoring it teaches the router something you cannot know. Ask the session\n` +
          `that ran it to score it — on this machine that is a SendMessage away.\n` +
          `If you are certain (correcting a score you know to be wrong), --force.`,
      )
    }
    const words = argv.slice(2).filter(
      (a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv.slice(2)[i - 1] ?? ''),
    )
    const delivery = words[0] as Delivery | undefined
    const quality = words[1] as Quality | undefined
    const fidelity = words[2] as Fidelity | undefined
    if (has('void')) {
      const cannotRecord = row.failure_kind === 'unevidenced'
        ? `${row.failure_kind} review`
        : row.failure_kind && NOT_EVIDENCE.includes(row.failure_kind)
          ? `failure kind '${row.failure_kind}' is not evidence`
          : null
      let scoredFidelity: Fidelity | undefined
      if (!cannotRecord && delivery) {
        if (!DELIVERY.includes(delivery)) {
          throw new Error(`delivery must be one of: ${DELIVERY.join(' | ')}`)
        }
        if (delivery === 'none' && quality) {
          throw new Error("delivery 'none' takes no quality: there was nothing to judge")
        }
        if (delivery !== 'none' && (!quality || !QUALITY.includes(quality))) {
          throw new Error(`delivery '${delivery}' needs a quality: ${QUALITY.join(' | ')}`)
        }
        const needsFidelity = Boolean(JOBS[row.job]?.needs.writesRepo) && delivery !== 'none'
        if (needsFidelity && (!fidelity || !FIDELITY.includes(fidelity))) {
          throw new Error(`${row.job} writes code, so verdicts require a fidelity axis`)
        }
        scoredFidelity = needsFidelity ? fidelity : undefined
      }
      const scoredAt = nowIso()
      writeTransaction(() => {
        voidAuthority = adoptRunMutation(voidAuthority!, 'void')
        db().query('UPDATE run SET evidence_excluded=? WHERE id=?')
          .run('voided with orch score --void', id)
        if (!cannotRecord && delivery) {
          recordScoreVerdict(
            id, delivery, quality ?? null, scoredFidelity ?? null, note, scoredAt,
            scorer ?? process.env.ORCH_SCORER ?? 'claude',
          )
        }
        auditRunMutation(voidAuthority!, 'void', auditReason())
      })
      const verdictResult = cannotRecord
        ? `verdict was not recorded: ${cannotRecord}`
        : delivery
          ? `verdict recorded: ${[delivery, quality, scoredFidelity].filter(Boolean).join(' ')}`
          : 'no verdict was provided; existing verdict unchanged'
      console.log(
        `voided run ${id}: retained run and output; excluded from routing evidence; ${verdictResult}`,
      )
      break
    }
    if (row.failure_kind === 'unevidenced') {
      throw new Error(`run ${id} cannot be scored: ${row.failure_kind} review`)
    }
    if (row.failure_kind && NOT_EVIDENCE.includes(row.failure_kind)) {
      throw new Error(
        `run ${id} cannot be scored: failure kind '${row.failure_kind}' is not evidence`,
      )
    }
    // A conversation is one unit of work and takes one verdict. Any turn id
    // resolves to the root, which is what routing reads and where the score is
    // recorded.
    // Only the session that read the output may judge it. Enforced here because
    // stating it in AGENTS.md did not hold: see judgeability() for the two
    // sessions that each scored the other's runs inside an hour, both believing
    // the ids were their own.
    // A PERSON scoring from the local dashboard is the gate's one legitimate
    // exception, proven by the dashboard process capability rather than by a
    // caller-controlled scorer label.
    //
    // The gate exists because an AGENT judging a run it did not read teaches
    // the router something false. Someone clicking a verdict has the output on
    // screen. The orchestrator's own dashboard used to bypass this by writing
    // the score table directly, which is the same exception made invisible;
    // `--scorer` records WHO judged it but grants no authority on its own.
    // `orch score 279 none` and `orch score 279 full right` are both complete
    // judgements; quality is meaningless without something to judge.
    //
    // Read positionally past the flags, not by index: `orch score 279 none
    // --note "..."` put `--note` in the quality slot and was rejected as an
    // incoherent judgement, which is a confusing way to be told about a typo
    // you did not make.
    /**
     * A writing job is judged on a third axis, and is REQUIRED to be.
     *
     * Optional, it would go unused: the two-axis habit is years old on this
     * machine and a run that looks complete and correct invites `full right`
     * without further thought — which is precisely the reading that cannot see
     * drift. Demanding the word forces the question to be asked, and the
     * question is the whole point of the axis.
     */
    const needsFidelity = Boolean(JOBS[row.job]?.needs.writesRepo) && delivery !== 'none'
    if (!delivery || !DELIVERY.includes(delivery)) {
      throw new Error(
        `first word is delivery — did an answer arrive?\n` +
          `  none      nothing usable came back (a vendor error, an empty reply, a denial)\n` +
          `  partial   an answer, but cut off or missing part of the ask\n` +
          `  full      a complete answer\n\n` +
          `then, unless delivery is 'none', quality — was it right?\n` +
          `  wrong     confidently incorrect, or answered a different question\n` +
          `  mixed     some of it right, some not\n` +
          `  right     correct and usable as it stands\n\n` +
          `  orch score ${id} full right --note "..."\n` +
          `  orch score ${id} none --note "..."`,
      )
    }
    if (delivery === 'none' && quality) {
      throw new Error("delivery 'none' takes no quality: there was nothing to judge")
    }
    if (delivery !== 'none' && (!quality || !QUALITY.includes(quality))) {
      throw new Error(`delivery '${delivery}' needs a quality: ${QUALITY.join(' | ')}`)
    }
    const reviewGradeFlags = ['reproduced', 'coverage', 'limits', 'overlap'] as const
    const suppliedReviewGradeFlags = reviewGradeFlags.filter((name) => flag(name) !== undefined)
    const findingsJob = Boolean(job(row.job).findings)
    if (suppliedReviewGradeFlags.length && !findingsJob) {
      throw new Error(
        `${row.job} is not a findings-producing lens; review grade flags are not valid for this job`,
      )
    }
    if (suppliedReviewGradeFlags.length && delivery === 'none') {
      throw new Error("delivery 'none' takes no review grades: there was no lens output to judge")
    }
    if (needsFidelity && (!fidelity || !FIDELITY.includes(fidelity))) {
      throw new Error(
        `${row.job} writes code, so it needs a third word — fidelity: did it build what\n` +
          `you asked for, or something it decided on instead?\n` +
          `  drifted   solved a different problem, or redesigned as it went\n` +
          `  partial   mostly the spec, with decisions taken that were not its to take\n` +
          `  faithful  built the spec, and ASKED wherever the spec ran out\n\n` +
          `Asking is faithful. A worker that stopped, asked, and built what it was told\n` +
          `did exactly the right thing and must not be marked down for it — read\n` +
          `'orch diff ${id}' against the spec rather than the summary it wrote itself.\n\n` +
          `  orch score ${id} ${delivery} ${quality} faithful --note "..."`,
      )
    }
    if (!needsFidelity && fidelity) {
      console.error(
        `${row.job} has no spec to be faithful to, so it is judged on two axes only`,
      )
    }
    const scoredFidelity = needsFidelity ? fidelity : undefined

    let reviewGrade: { output: ReturnType<typeof parseReviewOutput>; grades: ReviewGrades } | null = null
    if (findingsJob && delivery !== 'none') {
      const existing = db().query(
        `SELECT rl.id, COUNT(rf.id) AS findings
           FROM review_lens rl LEFT JOIN review_finding rf ON rf.review_lens_id=rl.id
          WHERE rl.run_id=? GROUP BY rl.id`,
      ).get(id) as { id: number; findings: number } | null
      let output: ReturnType<typeof parseReviewOutput> = null
      if (!existing) {
        if (!row.output_path || !existsSync(row.output_path)) {
          throw new Error(`run ${id} has no recorded output to capture as a review`)
        }
        output = parseReviewOutput(readFileSync(row.output_path, 'utf8'))
        if (!output) throw new Error(`run ${id} output does not satisfy the review contract`)
        const evidence = cleanReviewEvidence(id, output)
        if (evidence.failure) {
          throw new Error(`run ${id} cannot be scored: ${evidence.failure}`)
        }
      }
      const findings = existing?.findings ?? output!.findings.length
      const raw: Record<keyof ReviewGrades, string | undefined> = {
        reproduced: flag('reproduced'), coverage: flag('coverage'),
        limits: flag('limits'), overlap: flag('overlap'),
      }
      if (findings === 0) {
        raw.reproduced ??= 'none'
        raw.overlap ??= 'none'
        if (raw.reproduced !== 'none' || raw.overlap !== 'none') {
          throw new Error("a lens with findings:[] has --reproduced none and --overlap none")
        }
      }
      const valid =
        raw.reproduced && REVIEW_REPRODUCED.includes(raw.reproduced as ReviewReproduced) &&
        raw.coverage && REVIEW_COVERAGE.includes(raw.coverage as ReviewCoverage) &&
        raw.limits && REVIEW_LIMITS.includes(raw.limits as ReviewLimits) &&
        raw.overlap && REVIEW_OVERLAP.includes(raw.overlap as ReviewOverlap)
      if (!valid) {
        throw new Error(
          `${row.job} grading requires architect review fields:\n` +
          `  --reproduced ${REVIEW_REPRODUCED.join(' | ')}\n` +
          `  --coverage   ${REVIEW_COVERAGE.join(' | ')}\n` +
          `  --limits     ${REVIEW_LIMITS.join(' | ')}\n` +
          `  --overlap    ${REVIEW_OVERLAP.join(' | ')}`,
        )
      }
      reviewGrade = { output, grades: raw as ReviewGrades }
    }

    const comparisonFlags = ['better-than', 'worse-than', 'same-as'] as const
    const suppliedComparisons = comparisonFlags.filter((name) => flag(name) !== undefined)
    if (suppliedComparisons.length > 1) {
      throw new Error('--better-than, --worse-than, and --same-as are mutually exclusive')
    }
    const comparison = suppliedComparisons[0]
    if (comparison) {
      const otherIds = parseRunIds(flag(comparison)!, `--${comparison}`)
      const comparedAt = nowIso()
      if (comparison === 'better-than') {
        recordDuels(id, otherIds, sessionId(), comparedAt, has('force'))
      } else if (comparison === 'worse-than') {
        recordLosses(id, otherIds, sessionId(), comparedAt, has('force'))
      } else {
        recordTies(id, otherIds, sessionId(), comparedAt, has('force'))
      }
    }

    const wasScored = Boolean(db().query('SELECT 1 FROM score WHERE run_id=?').get(id))
    const scoredAt = nowIso()
    writeTransaction(() => {
      if (!dashboardAuthorized && !(has('force') && !scoreAuthority.actor)) {
        scoreAuthority = adoptRunMutation(scoreAuthority, 'score')
      }
      if (reviewGrade) gradeReviewLens(id, reviewGrade.output, reviewGrade.grades)
      recordScoreVerdict(
        id, delivery, quality ?? null, scoredFidelity ?? null, note, scoredAt,
        scorer ?? process.env.ORCH_SCORER ?? 'claude',
      )
      auditRunMutation(
        scoreAuthority, wasScored ? 'rescore' : 'score', auditReason(),
      )
    })
    const w = weigh(delivery, quality ?? null, scoredFidelity ?? null)
    const axes = [delivery, quality, scoredFidelity].filter(Boolean).join(' ')
    console.log(
      `run ${id} (${row.agent}/${row.job}) scored ${axes}  [${w}]`,
    )
    if (!comparison) {
      for (const partner of pairPartners(id, sessionId())) console.log(pairHint(partner))
    }
    break
  }

  case 'recalibrate': {
    await Promise.all([loadJobs(), loadAgreement()])
    const rawN = flag('n') ?? '12'
    const n = Number(rawN)
    if (!/^\d+$/.test(rawN) || !Number.isInteger(n) || n < 1) {
      throw new Error('--n must be a positive integer')
    }
    const scorer = flag('scorer') ?? process.env.ORCH_SCORER ?? 'claude'
    const rows = db().query(
      `SELECT r.id, r.job, r.output_path,
              s.delivery AS original_delivery, s.quality AS original_quality,
              s.fidelity AS original_fidelity
         FROM score s JOIN run r ON r.id = s.run_id
        WHERE datetime(s.scored_at) < datetime('now', '-7 days')
          AND (? = 1 OR s.scored_by = ?)
        ORDER BY random()`,
    ).all(has('force') ? 1 : 0, scorer) as {
      id: number; job: string; output_path: string | null
      original_delivery: Delivery; original_quality: Quality | null
      original_fidelity: Fidelity | null
    }[]
    const sample = rows.filter((row) => row.output_path && existsSync(row.output_path)).slice(0, n)
    if (!sample.length) {
      console.log('no scored runs older than 7 days with output still on disk')
      break
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const verdicts = rl[Symbol.asyncIterator]()
    const results: {
      original: [Delivery, Quality | null, Fidelity | null]
      fresh: [Delivery, Quality | null, Fidelity | null]
    }[] = []
    const calibrationAt = nowIso()
    try {
      for (const row of sample) {
        const output = readFileSync(row.output_path!, 'utf8')
        const excerpt = output.length <= 6000
          ? output
          : `${output.slice(0, 4000)}\n\n... output middle hidden ...\n\n${output.slice(-2000)}`
        const writes = Boolean(JOBS[row.job]?.needs.writesRepo)
        console.log(`\nrun ${row.id} / ${row.job}`)
        console.log(`axes: delivery quality${writes ? ' fidelity' : ''}`)
        console.log(excerpt)
        const hint = writes
          ? '<none | partial/full wrong/mixed/right drifted/partial/faithful>'
          : '<none | partial/full wrong/mixed/right>'
        process.stdout.write(`verdict ${hint}: `)
        const line = await verdicts.next()
        if (line.done) throw new Error('stdin ended before every sampled run was judged')
        const answer = line.value.trim().split(/\s+/)
        const delivery = answer[0] as Delivery | undefined
        const quality = answer[1] as Quality | undefined
        const fidelity = answer[2] as Fidelity | undefined
        if (!delivery || !DELIVERY.includes(delivery)) {
          throw new Error(`delivery must be one of: ${DELIVERY.join(' | ')}`)
        }
        if (delivery === 'none' && quality) {
          throw new Error("delivery 'none' takes no quality: there was nothing to judge")
        }
        if (delivery !== 'none' && (!quality || !QUALITY.includes(quality))) {
          throw new Error(`delivery '${delivery}' needs a quality: ${QUALITY.join(' | ')}`)
        }
        const needsFidelity = writes && delivery !== 'none'
        if (needsFidelity && (!fidelity || !FIDELITY.includes(fidelity))) {
          throw new Error(`this writing job needs fidelity: ${FIDELITY.join(' | ')}`)
        }
        if ((!needsFidelity && fidelity) || answer.length > (needsFidelity ? 3 : delivery === 'none' ? 1 : 2)) {
          throw new Error('too many verdict words for this run')
        }
        const fresh: [Delivery, Quality | null, Fidelity | null] = [
          delivery, quality ?? null, needsFidelity ? fidelity! : null,
        ]
        db().query(
          `INSERT INTO calibration (run_id, delivery, quality, fidelity, at, session_id)
           VALUES (?,?,?,?,?,?)`,
        ).run(row.id, ...fresh, calibrationAt, sessionId())
        results.push({
          original: [row.original_delivery, row.original_quality, row.original_fidelity], fresh,
        })
      }
    } finally {
      rl.close()
    }

    const axes = [
      { name: 'delivery', levels: DELIVERY as readonly string[], at: 0 },
      { name: 'quality', levels: QUALITY as readonly string[], at: 1 },
      { name: 'fidelity', levels: FIDELITY as readonly string[], at: 2 },
    ]
    const reading = (k: number) => k < 0.4 ? 'ambiguous rubric'
      : k <= 0.6 ? 'weak' : k <= 0.8 ? 'usable' : 'strong'
    for (const axis of axes) {
      const pairs = results.map((r) => [r.original[axis.at], r.fresh[axis.at]] as const)
        .filter((p) => p[0] != null && p[1] != null) as [string, string][]
      if (!pairs.length) continue
      const kappa = quadraticWeightedKappa(pairs, axis.levels)
      if (kappa === null) {
        const ac1 = gwetAc1(pairs, axis.levels)
        console.log(`${axis.name}: n=${pairs.length} kappa=n/a ac1=${ac1 === null ? 'n/a' : ac1.toFixed(3)} reading=not measurable`)
      } else {
        const ac1 = gwetAc1(pairs, axis.levels)
        console.log(`${axis.name}: n=${pairs.length} kappa=${kappa.toFixed(3)} ac1=${ac1 === null ? 'n/a' : ac1.toFixed(3)} reading=${reading(kappa)}`)
      }
    }
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
    const { idleLabel, idleMsSince } = await import('./events.ts')
    const { parseIdleReclaimedMs } = await import('./idle-kill.ts')
    const jsonV1 = argv.includes('--json=v1')
    const json = has('json') || jsonV1
    const where: string[] = ['r.parent_run_id IS NULL']
    if (!json) where.push('r.automatic_failover = 0')
    // Typed as the bindings SQLite actually accepts: `unknown[]` does not
    // satisfy the query signature, which is why this file never typechecked.
    const args: (string | number)[] = []
    const jobFlag = flag('job')
    if (jobFlag) { where.push('r.job = ?'); args.push(jobFlag) }
    const agentFlag = flag('agent')
    if (agentFlag) { where.push('r.agent = ?'); args.push(agentFlag) }
    const onlyUnscored = has('unscored')
    const unscoredCte = onlyUnscored ? `WITH RECURSIVE failover_chain(origin_id, root_id) AS (
      SELECT root.id, root.id FROM run root WHERE root.parent_run_id IS NULL
      UNION ALL
      SELECT chain.origin_id, successor.id
        FROM failover_chain chain
        JOIN run successor ON successor.id = (
          SELECT next.id FROM run next
           WHERE next.automatic_failover = 1
             AND next.retry_of IN (
               SELECT member.id FROM run member
                WHERE member.id = chain.root_id OR member.parent_run_id = chain.root_id
             )
           ORDER BY next.id LIMIT 1
        )
    ), final_failover(origin_id, root_id) AS (
      SELECT chain.origin_id, chain.root_id
        FROM failover_chain chain
       WHERE NOT EXISTS (
         SELECT 1 FROM run next
          WHERE next.automatic_failover = 1
            AND next.retry_of IN (
              SELECT member.id FROM run member
               WHERE member.id = chain.root_id OR member.parent_run_id = chain.root_id
            )
       )
    )` : ''
    const unscoredJoin = onlyUnscored ? 'JOIN final_failover final ON final.origin_id = r.id' : ''
    if (onlyUnscored) {
      const owedWhere = UNSCORED_WHERE.replaceAll('r.', 'owed.').replaceAll('s.', 'owed_score.')
      where.push(`EXISTS (
        SELECT 1 FROM run owed
        LEFT JOIN score owed_score ON owed_score.run_id = owed.id
        WHERE owed.id = final.root_id AND ${owedWhere}
      )`)
    }
    const sinceFlag = flag('since')
    const requestedIds = [...new Set(flags('id').map((value) => {
      const id = Number(value)
      if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid run id: ${value}`)
      return id
    }))]
    if (requestedIds.length && sinceFlag) {
      throw new Error('orch runs --id and --since cannot be combined')
    }
    if (requestedIds.length) {
      const marks = requestedIds.map(() => '?').join(',')
      // Runs normally presents one canonical row per resumed conversation. If
      // a caller names a child turn, return that conversation rather than
      // falsely reporting an existing run id as unknown.
      where.push(`(r.id IN (${marks}) OR EXISTS (
        SELECT 1 FROM run requested_turn
         WHERE requested_turn.parent_run_id = r.id
           AND requested_turn.id IN (${marks})
      ))`)
      args.push(...requestedIds, ...requestedIds)
    }
    if (sinceFlag) {
      // A chain belongs in the window when any turn started there, any
      // question was asked or answered there, or any question is still
      // unanswered — an open ruling is current whatever its age.
      where.push(`(
        EXISTS (
          SELECT 1 FROM run turn
           WHERE (turn.id = r.id OR turn.parent_run_id = r.id)
             AND turn.started_at >= ?
        ) OR EXISTS (
          SELECT 1 FROM question q JOIN run owner ON owner.id = q.run_id
           WHERE (owner.id = r.id OR owner.parent_run_id = r.id)
             AND (q.answered_at IS NULL OR q.asked_at >= ? OR q.answered_at >= ?)
        )
      )`)
      args.push(sinceFlag, sinceFlag, sinceFlag)
    }
    const limit = Number(flag('limit') ?? (json ? 100000 : 20))
    let rows = db().query(
      `${unscoredCte}
       SELECT r.id, r.started_at, r.agent, r.job, r.repo, r.latency_ms, r.vendor_tokens,
              current_run.status, current_run.failure_kind, current_run.error,
              current_run.last_event_at, current_run.started_at AS current_started_at,
              s.delivery, s.quality,
              COALESCE(r.label, r.prompt_head) AS prompt_head, r.route_reason, r.sandbox
              ${json ? ', r.cwd, r.session_id, r.vendor_cost_usd, r.probe, r.exit_code, r.input_tree, r.head_commit, r.review_ref,'
                        + ' r.prompt_path, r.branch, r.branch_kept, r.branch_kept_tip, r.retry_of, r.launch_key, r.evidence_excluded' : ''}
         FROM run r
         ${unscoredJoin}
         JOIN run current_run ON current_run.id = (
           SELECT member.id FROM run member
            WHERE member.id = r.id OR member.parent_run_id = r.id
            ORDER BY member.turn DESC, member.id DESC LIMIT 1
         )
         LEFT JOIN score s ON s.run_id = r.id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY r.id DESC LIMIT ?`,
    ).all(...args, limit) as Record<string, unknown>[]

    rows = rows.flatMap((r) => {
      const chain = resolveFailover(db(), Number(r.id))
      const final = chain.attempts.at(-1)!
      const current = json ? {} : db().query(
        `SELECT status, latency_ms, vendor_tokens, route_reason, probe, output_path
           FROM run WHERE id=?`,
      ).get(final.id) as {
        status: string; latency_ms: number | null; vendor_tokens: number | null
        route_reason: string | null; probe: number; output_path: string | null
      }
      const turns = json ? db().query(
        `SELECT id, started_at, latency_ms, vendor_tokens, vendor_cost_usd, status, turn, input_tree, sandbox
           FROM run WHERE id = ? OR parent_run_id = ?
          ORDER BY turn, id`,
      ).all(Number(r.id), Number(r.id)) : undefined
      const questions = json ? (db().query(
        `SELECT q.id, q.run_id, q.asked_at, q.answered_at
           FROM question q JOIN run owner ON owner.id = q.run_id
          WHERE owner.id = ? OR owner.parent_run_id = ?
          ORDER BY q.id`,
      ).all(Number(r.id), Number(r.id)) as {
        id: number; run_id: number; asked_at: string; answered_at: string | null
      }[]).map((q) => ({
        id: q.id, run_id: q.run_id, asked_at: q.asked_at, answered_at: q.answered_at ?? null,
      })) : undefined
      return [{
        ...r, ...current,
        ...(turns ? { turns } : {}),
        ...(questions ? { questions } : {}),
        answer_agent: final.agent,
        failover_chain: chain.attempts.map((attempt) => attempt.agent),
        ...(chainIsStranded(Number(r.id)) ? {
          status: 'stranded', stranded: true,
          recovery_hint: strandedRecovery(Number(r.id)),
        } : {}),
      }]
    })

    // Unknown means absent from orch, not merely absent from this presentation
    // (for example because an id names a child turn or another filter excludes
    // it). Omission and non-existence are different facts for machine callers.
    const knownIds = requestedIds.length ? new Set(
      (db().query(
        `SELECT id FROM run WHERE id IN (${requestedIds.map(() => '?').join(',')})`,
      ).all(...requestedIds) as { id: number }[]).map((row) => row.id),
    ) : new Set<number>()
    const unknownIds = requestedIds.filter((id) => !knownIds.has(id))

    if (requestedIds.length) {
      const rootByRequested = new Map((db().query(
        `SELECT id requested_id, COALESCE(parent_run_id, id) root_id
           FROM run WHERE id IN (${requestedIds.map(() => '?').join(',')})`,
      ).all(...requestedIds) as { requested_id: number; root_id: number }[])
        .map((requested) => [requested.requested_id, requested.root_id]))
      const requestedRoots = requestedIds.flatMap((requested_id) => {
        const root_id = rootByRequested.get(requested_id)
        return root_id === undefined ? [] : [{ requested_id, root_id }]
      })
      rows = rows.flatMap((row) => requestedRoots
        .filter((requested) => requested.root_id === Number(row.id))
        .map((requested) => ({
          ...row,
          requested_id: requested.requested_id,
          resolved_from: requested.requested_id === Number(row.id) ? 'root' : 'turn',
        })))
    }

    rows = rows.map((r) => {
      const live = r.status === 'running'
      const lastEventAt = (r.last_event_at as string | null) ?? null
      const startedAt = String(r.current_started_at ?? r.started_at)
      const idle = live ? idleLabel(lastEventAt, startedAt)
        : r.failure_kind === 'idle' ? 'idle-killed' : null
      const since = live ? idleMsSince(lastEventAt, startedAt) : null
      const { current_started_at: _currentStartedAt, ...rest } = r
      const reclaimed = r.failure_kind === 'idle'
        ? parseIdleReclaimedMs(String(r.error ?? ''))
        : null
      return {
        ...rest, idle, idle_ms: since,
        reclaimed_ms: reclaimed,
      }
    })

    // JSON Lines, so a consumer can stream it and a truncated read loses only
    // the last record. This is a published interface: `hub` reads it rather
    // than opening orch.db, because a database shared between two concerns is
    // how two concerns quietly become one.
    if (json) {
      const publish = (data: unknown) => JSON.stringify(
        jsonV1 ? data : { schema_version: 2, kind: 'run', data },
      )
      for (const r of rows) console.log(publish(r))
      for (const id of unknownIds) {
        console.log(publish({ id, status: 'unknown', unknown: true }))
      }
      break
    }

    if (!rows.length && !unknownIds.length) { console.log('no runs'); break }
    for (const r of rows) {
      const outcome = outcomeOf(r as OutcomeRow)
      const stranded = r.stranded === true
      const status = stranded ? 'stranded' : outcome.line.split(' - ', 1)[0]!
      const identity = r.resolved_from === 'turn'
        ? `${r.id} (asked as turn ${r.requested_id})`
        : String(r.id)
      console.log(
        `${identity.padStart(4)}  ${String((r.failover_chain as string[]).join('→')).padEnd(6)} ${String(r.job).padEnd(14)}` +
          // 'running' is not a failure, and a null latency is not zero seconds.
          ` ${String(r.status === 'failed' ? status.toUpperCase() : status).padEnd(10)}` +
          ` ${dur(r.latency_ms as number | null).padStart(8)}  ${String(r.prompt_head).slice(0, 60)}` +
          (r.idle ? `  ${r.idle}` : ''),
      )
      if (stranded) console.log(`      ${r.recovery_hint}`)
      else if (r.status === 'asking') console.log(`      ${outcome.line.slice(status.length + 3)}`)
      if (r.failure_kind === 'contract' || r.failure_kind === 'unevidenced') {
        console.log(`      ${failureReason(r as {
          status: string; error: string | null; failure_kind: string | null; exit_code: number | null
        })}`)
      }
      if (r.failure_kind === 'idle') {
        const reclaimed = r.reclaimed_ms as number | null
        console.log(`      idle-killed` +
          (reclaimed != null ? `; reclaimed ${dur(reclaimed)} of wall` : ''))
      }
      // The reason is where a fan-out says its exclusions ran out. Hiding it
      // here would leave the database honest and the human-facing command not.
      if (r.route_reason) console.log(`      route: ${String(r.route_reason)}`)
      const warning = thinOutputWarning({
        job: String(r.job), status: String(r.status),
        latency_ms: r.latency_ms as number | null,
        probe: Number(r.probe), output_path: r.output_path as string | null,
      })
      if (warning) console.log(`      ${warning}`)
    }
    for (const id of unknownIds) console.log(`${String(id).padStart(4)}  unknown run id`)
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
    const { landingsWithPostStepError } = await import('./landing.ts')
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
    await Promise.all([loadJobs(), loadAgents(), loadRoute(), loadAgreement(), loadDockerResources(), loadWorktree()])
    await ensureLocalHealth()
    const { LOCAL_BASE_URL, LOCAL_MODEL, LOCAL_CONTEXT_TOKENS } =
      await import('./agents.ts')
    // Probed BEFORE the agent list is printed, not after it. Doctor used to
    // report `qwen-local ready` and `reachable NO` four lines apart and mean
    // both: the roster asked whether it was configured and the probe asked
    // whether it answered. Now the roster is told the answer first, so the
    // status column and the routing table below it cannot contradict
    // each other.
    const r = await ensureLocalHealth()
    const { CanonBudgetError, compilePack, findingsForPack } = await import('./canon.ts')
    const { listDocs } = await import('./docs.ts')
    const { DEFAULT_PACK_BYTES, MAX_INJECT_DOC_BYTES } = await import('./pack-budget.ts')
    let doctorPack
    try { doctorPack = compilePack({ job: 'understand', cwd: process.cwd() }) }
    catch (error) {
      if (!(error instanceof CanonBudgetError)) throw error
      doctorPack = error.pack
    }
    const doctorFindings = findingsForPack(doctorPack).reduce((n, row) => n + row.findings.length, 0)
    const packHeadroom = doctorPack.budgetBytes - doctorPack.bytes
    const { CANON_EVALS, currentCanonEvalSha, latestCanonEvals } = await import('./evals.ts')
    const latestEvals = latestCanonEvals()
    const { isReadonlySandboxCandidate, srtInstalled, SRT_BIN } = await import('./sandbox.ts')
    console.log(`canon          ${doctorFindings} finding(s) in ${doctorPack.bytes}/${doctorPack.budgetBytes} bytes (${packHeadroom} bytes headroom; ceiling ${DEFAULT_PACK_BYTES})`)
    const oversized = listDocs().filter((doc) =>
      doc.delivery === 'inject' && Buffer.byteLength(doc.body) > MAX_INJECT_DOC_BYTES)
      .sort((a, b) => Buffer.byteLength(b.body) - Buffer.byteLength(a.body))
    if (oversized.length) {
      console.log('canon oversize')
      for (const doc of oversized) {
        console.log(`  ${Buffer.byteLength(doc.body)}  ${doc.scope}/${doc.subject ?? '_'}/${doc.slug}`)
      }
    }
    console.log('canon evals')
    for (const ev of CANON_EVALS) {
      const rows = latestEvals.filter((row) => row.slug === ev.slug)
      if (!rows.length) {
        console.log(`  ${ev.slug.padEnd(30)} skipped  —  never run`)
        continue
      }
      const currentSha = currentCanonEvalSha(ev)
      for (const row of rows) {
        const result = row.pass
          ? row.canon_sha === currentSha ? 'pass (current canon)' : 'pass'
          : 'FAIL'
        console.log(
          `  ${ev.slug.padEnd(30)} ${result.padEnd(20)} ${row.agent}  ${row.at}`,
        )
      }
    }
    const failingEvalSlugs = [...new Set(latestEvals.filter((row) => !row.pass).map((row) => row.slug))]
    if (failingEvalSlugs.length) {
      console.log(`FAILING CANON EVALS: ${failingEvalSlugs.join(', ')}`)
    }
    db()
    console.log(`database       ${DB_PATH}`)
    console.log(`open mode      ${databaseOpenMode()}`)
    const { expectedSchemaHash, canonicalSchemaHash, schemaVersionLabel } = await import('./migrations.ts')
    console.log(`schema hash    ${canonicalSchemaHash(db()) === expectedSchemaHash() ? 'match' : 'DRIFT'}`)
    console.log(`schema version ${schemaVersionLabel(db())}`)
    console.log(`resolved by    ${DATABASE_RESOLUTION.method}`)
    if (DATABASE_RESOLUTION.registeredPath && DATABASE_RESOLUTION.registeredPath !== DB_PATH) {
      console.log(`registered     ${DATABASE_RESOLUTION.registeredPath}  (resolved path won)`)
    }
    const { harnessHealth } = await import('./health.ts')
    const costlyFailures = harnessHealth().classes.filter((row) => row.count > 0)
      .sort((a, b) => b.totalTimeMs - a.totalTimeMs || a.kind.localeCompare(b.kind)).slice(0, 2)
    console.log('harness health top live classes by total time (14 days; never routing evidence)')
    for (const row of costlyFailures) {
      console.log(`  ${row.kind.padEnd(24)} ${(row.totalTimeMs / 60_000).toFixed(1)}m  last ${row.lastSeen}`)
    }
    const latestCalibration = db().query(
      'SELECT MAX(at) AS at FROM calibration',
    ).get() as { at: string | null }
    if (latestCalibration.at) {
      const calibrationRows = db().query(
        `SELECT s.delivery original_delivery, c.delivery fresh_delivery,
                s.quality original_quality, c.quality fresh_quality,
                s.fidelity original_fidelity, c.fidelity fresh_fidelity
           FROM calibration c JOIN score s ON s.run_id = c.run_id
          WHERE c.at = ?`,
      ).all(latestCalibration.at) as Record<string, string | null>[]
      console.log(`scorer calibration  ${latestCalibration.at}`)
      const calibrationAxes = [
        { name: 'delivery', levels: DELIVERY as readonly string[] },
        { name: 'quality', levels: QUALITY as readonly string[] },
        { name: 'fidelity', levels: FIDELITY as readonly string[] },
      ]
      for (const axis of calibrationAxes) {
        const pairs = calibrationRows.map((row) => [
          row[`original_${axis.name}`], row[`fresh_${axis.name}`],
        ] as const).filter((pair) => pair[0] !== null && pair[1] !== null) as [string, string][]
        if (!pairs.length) continue
        const kappa = quadraticWeightedKappa(pairs, axis.levels)
        const ac1 = gwetAc1(pairs, axis.levels)
        console.log(
          `  ${axis.name.padEnd(8)} n=${pairs.length} ` +
          `kappa=${kappa === null ? 'n/a' : kappa.toFixed(3)} ` +
          `ac1=${ac1 === null ? 'n/a' : ac1.toFixed(3)}`,
        )
      }
    } else {
      console.log('scorer calibration  never')
    }
    const scoresSinceCalibration = (db().query(
      `SELECT COUNT(*) n FROM score
        WHERE ? IS NULL OR datetime(scored_at) > datetime(?)`,
    ).get(latestCalibration.at, latestCalibration.at) as { n: number }).n
    const calibrationStale = !latestCalibration.at ||
      Date.now() - new Date(latestCalibration.at).getTime() >= 30 * 86_400_000 ||
      scoresSinceCalibration >= 100
    if (calibrationStale) {
      console.log(
        `recalibrate: ${scoresSinceCalibration} scores since last blind check; ` +
        'run orch recalibrate --n 12',
      )
    }
    console.log('agents')
    for (const a of Object.values(AGENTS)) {
      const cool = candidates('summarize').find((c) => c.agent === a.name)?.cooling
      const why = unavailableReason(a.name)
      const version = why === 'not installed' ? null : cliVersion(a.bin)
      const old = version?.parsed && versionBelow(version.parsed, a.minimumCliVersion)
      console.log(
        `  ${a.name.padEnd(12)} ${why ? 'absent ' : 'ready  '} ${a.billing.padEnd(13)}` +
          (why ? `  ${why}` : '') +
          (version ? `  version ${version.display}` : '  version unavailable') +
          (cool ? `  COOLING: ${cool}` : ''),
      )
      if (old) {
        console.log(
          `  WARNING: ${a.name} ${version.parsed} is below minimum ${a.minimumCliVersion}`,
        )
      }
      if (predatesFileContract(a)) {
        console.log(`  ${fileContractProbeReason(a.name)}`)
      }
    }
    for (const row of agentRows()) {
      if (row.billing !== 'local') continue
      const probedAt = row.probed_at ? Date.parse(row.probed_at) : NaN
      const ageDays = Number.isFinite(probedAt) ? (Date.now() - probedAt) / 86_400_000 : null
      const probe = row.probe_result ? JSON.parse(row.probe_result) as { ok?: boolean } : null
      const stale = ageDays !== null && ageDays > 7
      const failed = probe?.ok === false
      const age = ageDays === null ? 'never' : `${ageDays.toFixed(1)}d`
      if (stale || failed) {
        console.log(`local probe     ${row.name} FAIL ${age}${failed ? ' probe failed' : ' exceeds 7 days'}`)
        process.exitCode = 1
      } else {
        console.log(`local probe     ${row.name} ${age}`)
      }
    }
    const srtAgents = Object.values(AGENTS)
      .filter((agent) => isReadonlySandboxCandidate({
        agent: agent.name,
        readsRepo: agent.caps.readsRepo,
        writesRepo: false,
      }))
      .map((agent) => agent.name)
    console.log(
      `sandbox        srt ${srtInstalled() ? 'installed' : 'NOT INSTALLED'} at ${SRT_BIN}`,
    )
    console.log(`sandbox agents ${srtAgents.join(', ') || '(none)'} (read-only repository jobs)`)
    const { acpRuntimeGaps } = await import('./transport.ts')
    const acpGap = acpRuntimeGaps()
    console.log(`acp            ${acpGap ?? 'ready'}`)
    console.log(`\nlocal endpoint  ${LOCAL_BASE_URL || '(ORCH_LOCAL_BASE_URL unset)'}`)
    console.log(`local model     ${LOCAL_MODEL}`)
    console.log(`reachable       ${r.ok ? 'yes' : 'NO'} — ${r.detail}`)
    const localRegistered = LOCAL_BASE_URL && agentRows().some((row) =>
      Boolean(row.enabled) && row.transport === 'acp' && row.base_url === LOCAL_BASE_URL)
    if (LOCAL_BASE_URL && !localRegistered) {
      const configuredModel = process.env.ORCH_LOCAL_MODEL
      console.log(configuredModel
        ? `register        orch agent add local-acp --harness goose --backend vllm --model ${configuredModel} --base-url ${LOCAL_BASE_URL}`
        : 'register        ORCH_LOCAL_MODEL is required before registering local-acp')
    }
    if (!r.ok && LOCAL_BASE_URL) {
      // Reporting commands do not have side effects, so doctor only sends a
      // packet when asked in as many words. `orch do` wakes on its own; a
      // status check that silently powered on a shared machine would be a
      // surprise, and the surprise would land on a colleague.
      if (has('wake')) {
        const w = tryWake()
        console.log(`\nwake            ${w.sent ? 'SENT' : 'not sent'} — ${w.detail}`)
      } else {
        const d = wakeStatus()
        const last = lastWakeAttempt()
        console.log(
          `\nwake            ${d.send ? 'available — orch doctor --wake' : d.detail}` +
            (last ? `  (last attempt ${last.toISOString()})` : ''),
        )
      }
    }
    if (!r.ok && LOCAL_BASE_URL) {
      // The endpoint is a tunnel to another machine, so "not reachable" has a
      // short list of causes and they are checked in a fixed order. Printed
      // here because this is where somebody looks when the local model goes
      // quiet, and the alternative is rediscovering the list each time.
      console.log(
        '\nthe local model is out of routing until this clears. In order:\n' +
        '  1. is the box up?      ping <host-alias>\n' +
        '  2. is the tunnel up?   launchctl list com.user.local-model-tunnel\n' +
        '     and its log:        ~/Library/Logs/local-model-tunnel/launchd.err.log\n' +
        '  3. is the server up?   ssh <host-alias> \'docker ps\'\n' +
        'Routing has already excluded it, so nothing is being sent at it meanwhile.',
      )
    }
    // Where someone looks when an agent has gone quiet, so it is where the way
    // out belongs. A cooldown clears on the agent's next success, and routing
    // will not send it one while anything else can take the work — so without
    // this the only options are waiting out the hour or reading route.ts.
    if (candidates('summarize').some((c) => c.cooling)) {
      console.log(
        '\nan agent is cooling. If you have fixed the cause — topped up a quota,\n' +
        'logged back in — prove it and the cooldown clears immediately:\n' +
        '  orch do file-question --agent <name> --probe "Reply with exactly: OK"\n' +
        'A probe never counts as routing evidence, but it does count as being alive.',
      )
    }
    // The served window decides which jobs the local model is eligible for, so
    // a silent drift between what is declared and what is running would route
    // work at an agent that cannot hold it — which is how it came to be handed
    // four review-lenses and an `understand` it could never have finished.
    if (r.contextTokens) {
      const agree = r.contextTokens === LOCAL_CONTEXT_TOKENS
      console.log(
        `context         ${(r.contextTokens / 1024).toFixed(0)}K served` +
          (agree ? ' (matches what routing assumes)'
                 : `  MISMATCH — routing assumes ${(LOCAL_CONTEXT_TOKENS / 1024).toFixed(0)}K.` +
                   ` Set ORCH_LOCAL_CONTEXT=${r.contextTokens} or re-serve.`),
      )
    }
    const counts = runTotals()
    // runTotals().unscored, not runs - scored: that subtraction counts probes,
    // in-flight runs, failures and abandoned rows as debt, and reported 28
    // owing where `orch pending` — the command that actually tells you what
    // to do about it — reported none.
    console.log(`\nruns ${counts.runs}, scored ${counts.scored}, voided ${counts.voided}, unscored ${counts.unscored}`)
    const heldCandidates = db().query(
      `SELECT worktree, MAX(keep_tree) keep_tree FROM run
        WHERE worktree IS NOT NULL AND status IN ('ok','failed','stale','stopped')
        GROUP BY worktree`,
    ).all() as { worktree: string; keep_tree: number }[]
    let explicitHolds = 0
    let dirtyHolds = 0
    for (const held of heldCandidates) {
      if (held.keep_tree) explicitHolds++
      else if (existsSync(held.worktree) && worktreeDirty(held.worktree).dirty) dirtyHolds++
    }
    console.log(`held worktrees ${explicitHolds + dirtyHolds} (${dirtyHolds} dirty, ${explicitHolds} --keep-tree)`)
    const { projects: registeredProjects, undeclaredCommitHooks, registerBranchCheck } = await import('./projects.ts')
    const hookFlags = registeredProjects().map(undeclaredCommitHooks).filter(Boolean)
    if (hookFlags.length) {
      console.log('\ncommit hooks skipped in worker trees; landing gate must declare the checks:')
      for (const line of hookFlags) console.log(`  ${line}`)
    }
    const registerQuestions = registeredProjects().flatMap((project) =>
      registerBranchCheck(project).problems.map((problem) => `${project.name}: ${problem}`))
    if (registerQuestions.length) {
      console.log('\nregister questions (not run failures):')
      for (const question of registerQuestions) console.log(`  ${question}`)
    }
    const docker = dockerRunResources()
    const dockerOwnerIds = new Set(docker.resources.map(({ runId }) => runId))
    const owners = (db().query('SELECT id, repo, worktree, status FROM run').all() as {
      id: number; repo: string | null; worktree: string | null; status: string
    }[]).map((owner) => ({
      ...owner,
      retentionReason: dockerOwnerIds.has(owner.id)
        ? terminalDockerRetentionReasonForRun(db(), owner.id)
        : null,
    }))
    const classified = classifiedDockerResources(docker.resources, owners)
    const orphans = classified.filter(({ condition }) => condition === 'leaked')
    const retained = classified.filter(({ condition }) => condition === 'retained-worktree-resources')
    console.log(`\ndocker orphans  ${orphans.length}`)
    for (const { resource, project } of orphans) {
      console.log(`  ${resource.kind} ${resource.name} — project ${project}, run ${resource.runId}`)
      console.log(`    ${dockerRemovalCommand(resource)}`)
    }
    console.log(`docker retained worktree resources  ${retained.length}`)
    for (const { resource, project, reason } of retained) {
      console.log(`  ${resource.kind} ${resource.name} — project ${project}, run ${resource.runId}; informational, ${reason ? `removal could not be ascertained: ${reason}; ` : ''}no removal suggested`)
    }
    for (const error of docker.errors) console.log(`  inventory unavailable: ${error}`)
    for (const j of Object.keys(JOBS)) {
      try { const p = pick(j); console.log(`  ${j.padEnd(15)} -> ${p.agent}`) }
      catch (e) { console.log(`  ${j.padEnd(15)} -> none (${(e as Error).message})`) }
    }
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
