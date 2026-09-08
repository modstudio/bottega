import {
  mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync, rmSync,
  realpathSync, statSync, unlinkSync, symlinkSync, readlinkSync, lstatSync,
  copyFileSync, renameSync, chmodSync,
} from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import {
  classify, notify, isNonAnswer, hasVendorTerminationMarker, detectBlockers, NEEDS_HUMAN, NEEDS_HUMAN_TITLE,
  FAILS_OVER,
} from './failure.ts'
import {
  AGENTS, ensureLocalHealth, tryWake, readStrictCodexSchema, minimumCliVersionRefusal,
  LOCAL_BASE_URL,
} from './agents.ts'
import {
  job, isReaderJob, jobIdleKillMs, reclaimsTreeByDefault, resolveJobTimeoutMs, jobBoundInstruction,
  type Job,
} from './jobs.ts'
import { pick } from './route.ts'
import {
  db, nowIso, DB_PATH, sessionId, resolveRootFromLastTurn, tryWriteContention, writableDb, writeTransaction,
  enableSchemaReload, teardownTerminalRunResources,
} from './db.ts'
import { CONNECTION_SCHEMA_INVARIANT } from './migrations.ts'
import {
  createWorktree, createWithTool, createReadOnlyWorktree, createReadOnlyWithTool,
  toolFor, changesIn, repoRootOf, resolveBase, resolveReadOnlyBase, worktreeGitDir,
  realpathOrSpelled, withoutTrailingSeparators,
  createCommandExists,
  prepareWorktreeObjects, prepareSharedRefGuard, carryWorkingState,
  assertSharedRefGuardOutsideWritableRoots,
  targetGitEnvironment,
  workerSharedGitRoots,
  contentTree,
  assertCallerAncestry, withWorktreeCreateLock, withWorktreeLease, withCleanupLock,
  removeFor, type Worktree,
  type WorktreeObjectEnvironment, validateSeedWithTool,
} from './worktree.ts'
import { recipeNotes } from './recipe.ts'
import {
  workerPreamble, packResumePrompt, READONLY_PREAMBLE, NO_REPO_PREAMBLE, WORKER_SCHEMA, ISSUE_WORKER_SCHEMA, REVIEW_SCHEMA,
  TEXT_REPLY_SCHEMA, TEXT_REPLY_SCHEMA_NAME, REPLY_FILE_NAME, replyFileInstruction,
  REVIEW_SEVERITY_INSTRUCTION,
  VERIFY_CLAIM_SCHEMA, READER_SCHEMA, readerDeliverablesInstruction,
  parseWorkerReplyWithCount, isAsking, realQuestions, validatesSchema,
  parseReaderOutput, missingDeclaredDeliverables, UNEVIDENCED_DELIVERABLE_ERROR,
  type CanonSource, type WorkerReply,
} from './contract.ts'
import {
  CALIBRATION_SUFFIX_RESERVE_BYTES, calibrationLine, cleanReviewEvidence,
  parseReviewOutput, recordReview, reviewCalibration,
} from './review.ts'
import { assertMainCheckoutClean, assertRegisterBranches, createHasPlaceholder, projectAt, projectByName, projects, stackAt,
         validateStoredProjectSettings } from './projects.ts'
import { compilePack, recordPack } from './canon.ts'
import { seedGuidance } from './args.ts'
import { resolveRunsDirectory } from './database-location.ts'
import { resolveLandingBranch } from './landing.ts'
import { resolveLens } from './lenses.ts'
import { TRUNCATED_TRANSCRIPT_BYTES } from './result-output.ts'
import { addedGrokTrustHeadings, grokTrustHeadings } from './grok-trust.ts'
import { prepareSandboxHome, selectReadonlySandbox, srtLaunchArgv } from './sandbox.ts'
import {
  classifyDivergence, freezeCheckouts, overlappingError, type CheckoutToWatch,
  type ConfinementEvent, type FreezeFailure,
} from './confinement.ts'
import {
  mcpCallEvidence, namesSeenAt, probeMcpServer, readMcpConfig, resolveMcpServerUrl,
  storedMcpProbe, wrongProjectReason,
} from './mcp-probe.ts'
import { startAskLoopback, type AskLoopback } from './ask.ts'
import { receiptWorkerMessages, unreadWorkerMessages } from './mailbox.ts'
import {
  resolveTransportName, assertAcpAllowed, assertAcpReady, transportFor,
  selectAgentForTransport, isTestTransportInstalled, valueMatchesStrictSchema,
  schemaMismatchError, stopErrorMessage, failureKindFromStop,
  type TransportName, type TransportStartOpts, type TransportResult,
} from './transport.ts'
import { teeTransportEvents } from './events.ts'
import { checkpointRun, DEFAULT_CHECKPOINT_MINUTES, latestCheckpoint } from './checkpoint.ts'
import {
  formatIdleKillError, idlePollMs, shouldIdleKill, terminateProcessGroup,
} from './idle-kill.ts'

export { TRUNCATED_TRANSCRIPT_BYTES }

export type RunResult = {
  id: number
  agent: string
  reason: string
  output: string
  latencyMs: number
  exitCode: number
  vendorTokens: number | null
  /** Only grok reports what a call cost; null everywhere else. */
  costUsd: number | null
  outPath: string
  /** Where a repository worker ran, and what it changed. Null for a non-repository job. */
  worktree: Worktree | null
  changes: import('./worktree.ts').Changes | null
  /** The worker's structured reply, when the job carried a contract. */
  contract: WorkerReply | null
  /** Terminal state, so a caller can tell `asking` from `ok` without re-reading the row. */
  status: string
}

/** Read-only repository jobs isolate scratch objects; writing jobs need durable commits. */
export function gitObjectEnvironmentFor(
  agent: string,
  requestedJob: Job,
  worktree: Worktree | null,
): WorktreeObjectEnvironment | undefined {
  return agent === 'codex' && requestedJob.needs.readsRepo && worktree &&
    !requestedJob.needs.writesRepo
    ? prepareWorktreeObjects(worktree.path)
    : undefined
}

export type DetachSpec = {
  agent?: string; schema?: string; mcp?: McpRequest; model?: string; probe?: boolean
  /** Selectable seam. Default stays `cli`; `acp` covers paid agents on read-only jobs. */
  transport?: TransportName
  label?: string
  lens?: string
  /** How much database the worktree gets, where the project asks for a choice. */
  seed?: string
  /** A ticket key, where the project's branch convention requires one. */
  key?: string
  /** Explicit project attribution; it does not change the directory the worker uses. */
  repo?: string
  base?: string
  avoid?: string[]
  distinctModels?: string[]
  /** Retry only: the run this replaces, and the directory it ran in. */
  retryOf?: number; cwd?: string
  /** Disable automatic vendor-failure failover for this whole chain. */
  noFailover?: boolean
  /** Take the next eligible agent when the preferred row is at its concurrency cap. */
  noWaitCapacity?: boolean
  /** Carry the caller's uncommitted work into a newly cut worktree. Opt-in. */
  carry?: boolean
  /** Branch or run id whose recorded branch a findings job reviews. */
  review?: string
  /** Preserve the session that owns a successor root. */
  ownerSession?: string | null
  /** Declared reader deliverable names, from repeated `--deliverable`. */
  deliverables?: string[]
  /** `orch do --timeout` in minutes. */
  timeoutMinutes?: number
  /** Opt out of reclaim-at-terminalisation for lens and reader jobs. */
  keepTree?: boolean
  /** Resume only: everything needed to continue a worker where it stopped. */
  resume?: {
    parent: number; agent: string; session?: string; turn: number
    /** Continue the chain and retained tree in a new vendor conversation. */
    fresh?: boolean
    sessionId: string | null
    worktree: Worktree | null
  }
}

/** Resolve retry model affinity when the caller keeps or changes the agent. */
export function retryModelForAgent(
  originalAgent: string,
  originalModel: string | null,
  retryAgent: string,
  explicitModel?: string,
): string | undefined {
  if (explicitModel !== undefined) return explicitModel
  if (retryAgent === originalAgent) return originalModel ?? undefined
  const pin = AGENTS[retryAgent]
  if (!pin) throw new Error(`unknown agent "${retryAgent}"`)
  return pin.model
}

/** Latest stored transport on a chain. ORCH_TRANSPORT is not consulted. */
export function chainTransport(rootId: number): TransportName | null {
  const row = db().query(
    `SELECT transport FROM run
      WHERE (id = ? OR parent_run_id = ?) AND transport IS NOT NULL
      ORDER BY turn DESC, id DESC LIMIT 1`,
  ).get(rootId, rootId) as { transport: string } | null
  return row?.transport === 'cli' || row?.transport === 'acp' ? row.transport : null
}

function resolveRunTransport(opts: {
  transport?: TransportName
  resume?: { parent: number }
}): TransportName {
  if (opts.resume) {
    const inherited = chainTransport(opts.resume.parent)
    if (inherited) return inherited
  }
  return resolveTransportName(opts.transport)
}

/** Translate the detached wire format into the names run() consumes. */
export function detachedRunOptions(
  jobName: string, prompt: string, reserveId: number, spec: DetachSpec,
) {
  const {
    agent, schema, mcp, model, probe, transport, label, lens, seed, key, repo, base, avoid,
    distinctModels, retryOf, cwd, noFailover, noWaitCapacity, carry, review, ownerSession, resume,
    deliverables, timeoutMinutes, keepTree,
  } = spec
  // Adding a field to DetachSpec must fail typechecking until it is handled here.
  const consumed: Required<Record<keyof DetachSpec, unknown>> = {
    agent, schema, mcp, model, probe, transport, label, lens, seed, key, repo, base, avoid,
    distinctModels, retryOf, cwd, noFailover, noWaitCapacity, carry, review, ownerSession, resume,
    deliverables, timeoutMinutes, keepTree,
  }
  void consumed
  return {
    job: jobName, prompt, reserveId,
    agent, schemaPath: schema, mcp, model, probe, transport, label, lens, seed, key, repo, base, avoid,
    distinctModels, retryOf, cwd, noFailover, noWaitCapacity, carry, review, ownerSession, resume,
    deliverables, timeoutMinutes, keepTree,
  }
}

const EXPLICIT_REVIEW_JOBS = new Set(['review-lens', 'safety', 'craft'])

/** Trunk merge-base of a reviewed commit. Same resolution for --review and implicit lenses. */
function resolveReviewMergeBase(cwd: string, commit: string, trunk: string): string | null {
  const trunkCommit = resolveBase(cwd, `${trunk}^{commit}`)
  return gitContext(cwd, 'merge-base', commit, trunkCommit)
}

/** Coverage base for a findings job dispatched without --review. Null if unmeasurable. */
function implicitReviewCoverageBase(cwd: string): string | null {
  const trunk = projectAt(cwd)?.settings.trunk?.trim()
  if (!trunk) return null
  try {
    const commit = resolveBase(cwd, 'HEAD')
    return resolveReviewMergeBase(cwd, commit, trunk)
  } catch {
    return null
  }
}

export function resolveReviewTarget(
  jobName: string, cwd: string, reviewRef?: string, carry = false,
): { branch: string; commit: string; base: string } | null {
  if (reviewRef === undefined) return null
  if (!EXPLICIT_REVIEW_JOBS.has(jobName)) {
    throw new Error('--review is only valid for review-lens, safety, and craft')
  }
  const project = projectAt(cwd)
  const tool = project?.settings.worktree
  if (tool?.create && !createHasPlaceholder(tool.create, 'base')) {
    throw new Error(
      `project ${project!.name}: worktree.create has no {base} placeholder; --review needs one`,
    )
  }
  if (tool?.create && tool.detached !== true) {
    throw new Error(
      `project ${project!.name}: worktree.create does not declare detached review support.\n` +
      `  orch project set ${project!.name} --settings '{"worktree":{"detached":true}}'`,
    )
  }
  const { branch } = resolveLandingBranch(reviewRef)
  if (carry && branchOf(cwd) !== branch) {
    throw new Error(
      `--review ${reviewRef} resolves to branch ${branch}, but --carry was requested from ` +
      `${branchOf(cwd) ?? '(detached HEAD)'}; run --carry from that branch's own worktree`,
    )
  }
  const trunk = project?.settings.trunk?.trim()
  if (!trunk) {
    throw new Error(
      `project ${project?.name ?? '(unregistered)'} has no trunk configured; ` +
      '--review needs one to measure the reviewed change',
    )
  }
  const commit = resolveBase(cwd, `${branch}^{commit}`)
  const base = resolveReviewMergeBase(cwd, commit, trunk)
  if (!base) {
    throw new Error(`cannot find merge-base between review target ${branch} and trunk ${trunk}`)
  }
  return { branch, commit, base }
}

export function implicitReviewWarning(cwd: string): string {
  const branch = branchOf(cwd) ?? '(detached HEAD)'
  const p = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--verify', 'HEAD^{commit}'], {
    env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'ignore',
  })
  const commit = p.exitCode === 0 ? p.stdout.toString().trim() : null
  return `reviewing ${branch} at ${commit?.slice(0, 8) ?? 'unknown'}; pass --review <branch> to be explicit`
}

/**
 * How deep a chain of delegations may go. One means: this session may delegate,
 * and what it delegates to may not delegate again.
 *
 * A delegated agent gets a shell in the caller's checkout, so it can and does
 * run `orch` itself — one review-lens here fanned out to a second agent that
 * nobody asked for, under the caller's session id, and that run then counted as
 * routing evidence. Delegation has to bottom out somewhere, and the agent doing
 * the work is not the place to decide where.
 */
export const MAX_DEPTH = 1
export const MAX_FAILOVER_ATTEMPTS = 3

export const depth = () => Number(process.env.ORCH_DEPTH ?? 0)

export { resolveRootFromLastTurn }

/** Mark only an answered child turn that now has a successor as completed. */
export function resolveSupersededTurn(database: Database, rootId: number, turn: number): number {
  return database.query(
    `UPDATE run AS prior SET status='ok'
      WHERE prior.parent_run_id=? AND prior.turn=? AND prior.status='asking'
        AND EXISTS (
          SELECT 1 FROM question q
           WHERE q.run_id=prior.id AND q.answered_at IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM question q
           WHERE q.run_id=prior.id AND q.answered_at IS NULL
        )
        AND EXISTS (
          SELECT 1 FROM run later
           WHERE later.parent_run_id=prior.parent_run_id AND later.turn>prior.turn
        )`,
  ).run(rootId, turn).changes
}

type FailoverAttempt = { id: number; agent: string }

/** Walk retry_of backward; parent_run_id is only the conversation axis within an attempt. */
function failoverAttempts(id: number): FailoverAttempt[] {
  const attempts: FailoverAttempt[] = []
  let memberId: number | null = id
  while (memberId) {
    const member = db().query(
      'SELECT id, agent, parent_run_id FROM run WHERE id=?',
    ).get(memberId) as { id: number; agent: string; parent_run_id: number | null } | null
    if (!member) break
    const rootId = member.parent_run_id ?? member.id
    const root = db().query(
      'SELECT id, agent, retry_of, automatic_failover FROM run WHERE id=?',
    ).get(rootId) as
      { id: number; agent: string; retry_of: number | null; automatic_failover: number }
    attempts.unshift({ id: root.id, agent: root.agent })
    memberId = root.automatic_failover ? root.retry_of : null
  }
  return attempts
}

function appendFailoverRefusal(id: number, reason: string): void {
  db().query(
    `UPDATE run SET error=COALESCE(error || '\n', '') || ? WHERE id=?`,
  ).run(`Failover refused: ${reason}`, id)
}

export function writingFailoverRefusal(
  writesJob: boolean,
  changes: import('./worktree.ts').Changes | null,
  worktree: string,
): string | null {
  // "Clean" means no change from this run's immutable base, not an empty
  // porcelain status. A worker may commit normally now; changesIn includes
  // those commits, and handing that branch to a second agent would mix two
  // authors' work in the one diff this guard exists to protect.
  if (!writesJob) return null
  if (changes && changes.files.length === 0) return null
  const detail = changes
    ? `${changes.files.length} changed file(s)`
    : 'the worktree diff could not be read'
  return `writing run has ${detail}; preserving worktree ${worktree} so two agents never share one diff`
}

export type McpConnection = {
  server: string
  connected: boolean | null
  error: string | null
  namesSeen?: string[]
}

export type McpMode = 'require' | 'prefer'
export type McpRequest = boolean | McpMode

export function requestedMcpMode(request: McpRequest | undefined): McpMode | null {
  if (request === 'prefer') return 'prefer'
  return request ? 'require' : null
}

/** Existing run.mcp stores none=0, require=1, and prefer=2. */
export function storedMcpRequest(request: McpRequest | undefined): number {
  const mode = requestedMcpMode(request)
  return mode === 'prefer' ? 2 : mode === 'require' ? 1 : 0
}

/** Read the tri-state request while preserving compatibility with older mirror rows. */
export function mcpRequestFromStored(
  stored: number | null, error: string | null = null,
): McpMode | undefined {
  if (stored === 2) return 'prefer'
  if (stored === 1) return error?.startsWith('mirror:') ? 'prefer' : 'require'
  return undefined
}

type McpConfigPreflight = { header: string | null; error: string | null }

/** Put cwd-discovered project MCP config at the address the vendor will inspect. */
export function provisionMcpConfig(worktree: string, checkout: string): McpConfigPreflight {
  const target = join(worktree, '.mcp.json')
  if (existsSync(target)) return { header: null, error: null }
  const source = join(checkout, '.mcp.json')
  if (!existsSync(source)) {
    return {
      header: null,
      error: `missing .mcp.json in worker cwd ${worktree}; registered checkout ${checkout} has no .mcp.json either`,
    }
  }
  const link = relative(dirname(target), source)
  symlinkSync(link, target)
  return { header: `MCP preflight: linked .mcp.json -> ${link}`, error: null }
}

/** Keep orch's cwd-discovery link outside trees and patches attributed to the worker. */
function withoutProvisionedMcpConfig<T>(
  worktree: string, link: string | null, measure: () => T,
): T {
  if (link === null) return measure()
  const target = join(worktree, '.mcp.json')
  try {
    if (!lstatSync(target).isSymbolicLink() || readlinkSync(target) !== link) return measure()
  } catch {
    return measure()
  }
  unlinkSync(target)
  try {
    return measure()
  } finally {
    symlinkSync(link, target)
  }
}

/** Recognise only the checkout link orch itself would provision in this worktree. */
function existingProvisionedMcpConfigLink(worktree: string, checkout: string): string | null {
  const target = join(worktree, '.mcp.json')
  const expected = relative(dirname(target), join(checkout, '.mcp.json'))
  try {
    return lstatSync(target).isSymbolicLink() && readlinkSync(target) === expected
      ? expected
      : null
  } catch {
    return null
  }
}

/** The provenance value orch can establish from this run's dispatch facts. */
export function canonSourceFor(
  mcpRequested: boolean,
  connection: McpConnection | null,
  mirrorAvailable: boolean,
): CanonSource {
  if (!mcpRequested) return mirrorAvailable ? 'mirror' : 'unknown'
  if (connection?.connected === true) return 'live database'
  if (connection?.connected === false) return 'mirror'
  return 'unknown'
}

export function canonSourceInstruction(source: CanonSource): string {
  return (
    `Canon source provenance: set provenance.canon_source to "${source}" in your reply. ` +
    'This reports the canon source available to this run, whether or not you consulted canon.'
  )
}

const CANON_SOURCE_PROMPT_RESERVE_BYTES = Math.max(
  ...(['live database', 'mirror', 'unknown'] as CanonSource[])
    .map((source) => Buffer.byteLength(canonSourceInstruction(source))),
) + 2

/**
 * Ask the same client that will run the lens whether its project MCP can start.
 * Grok gates repo-local MCP behind folder trust separately from permission
 * mode. The deferred orch-worktree path passes trust; caller-checkout probes do not.
 */
export function grokMcpConnection(
  bin: string, cwd: string, server: string, env: Record<string, string>, trust = false,
): McpConnection {
  const p = Bun.spawnSync([
    bin, ...(trust ? ['--cwd', cwd, '--trust'] : []), 'mcp', 'doctor', server, '--json',
  ], {
    cwd, env, stdout: 'pipe', stderr: 'pipe',
  })
  const stdout = p.stdout.toString().trim()
  const stderr = p.stderr.toString().trim()
  try {
    const report = JSON.parse(stdout) as {
      servers?: { name?: string; healthy?: boolean; checks?: {
        passed?: boolean; label?: string; detail?: string; hint?: string
      }[] }[]
    }
    const found = report.servers?.find((candidate) => candidate.name === server)
    const available = (report.servers ?? [])
      .map((candidate) => candidate.name)
      .filter((name): name is string => Boolean(name))
    if (found) {
      const error = (found.checks ?? [])
        .filter((check) => check.passed === false)
        .map((check) => [check.label, check.detail, check.hint].filter(Boolean).join(': '))
        .join('; ')
      return { server, connected: found.healthy === true, error: error || null, namesSeen: available }
    }
    const listed = available.length ? available.join(', ') : '(none)'
    return {
      server,
      connected: false,
      namesSeen: available,
      error: [
        stderr, stdout,
        `MCP server '${server}' was not reported. Available: ${listed}`,
      ].filter(Boolean).join('\n'),
    }
  } catch { /* preserve the client's actual diagnostic below */ }
  return {
    server,
    connected: false,
    error: [stderr, stdout].filter(Boolean).join('\n') || `MCP server '${server}' was not reported`,
  }
}

/**
 * Who can prove attachment, and what they proved.
 *
 * A red grok probe is evidence about grok, not about the machine. Codex has no
 * diagnostic, so it cannot prove failure and cannot prove success — that is
 * unverified, not connected:false. Routing around grok's attach failure is
 * DEV-194 and is not done here.
 */
function mcpConnectionFor(
  name: string, cwd: string, server: string, trust = false, includeStore = true,
): McpConnection {
  if (name === 'grok') {
    const grok = AGENTS.grok!
    return grokMcpConnection(grok.bin, cwd, server, childEnv(grok, undefined, undefined, {}, includeStore), trust)
  }
  return {
    server,
    connected: null,
    error: `${name} does not expose an MCP connection diagnostic`,
  }
}

function mcpAttachRefusal(connection: McpConnection): string | null {
  if (connection.connected !== false) return null
  return (
    `MCP was requested, but server '${connection.server}' could not be attached` +
    `${connection.error ? `: ${connection.error}` : '.'} The agent was not started.`
  )
}

export function assertGrokTrustEligible(
  cwd: string,
  recorded: {
    id?: number
    cwd?: string | null
    worktree: string | null
    worktree_source: string | null
  } | null,
  runsDir = RUNS_DIR,
): void {
  const orchCut = recorded?.worktree === cwd &&
    ['recipe', 'git', 'readonly_recipe'].includes(recorded.worktree_source ?? '')
  const orchIsolate = recorded?.worktree === null && recorded.id !== undefined &&
    recorded.cwd === cwd && noRepoIsolatePath(recorded.id, runsDir) === cwd
  if (orchCut || orchIsolate) return
  throw new Error(
    `refusing Grok trust for ${cwd}: trust is granted only to trees orch cut; ` +
    'removed tree paths never recur',
  )
}

function probeRequestedMcp(mcp: McpRequest | undefined, agent: string, cwd: string): McpConnection | null {
  if (!requestedMcpMode(mcp)) return null
  const project = projectAt(cwd)
  if (!project) return null
  return mcpConnectionFor(agent, cwd, project.settings.mcpServer ?? project.name)
}

/**
 * Refuse a --mcp dispatch that routing would send to an agent whose attach
 * we can prove failed. No-repo MCP and cwd-discovered repository MCP are
 * deferred until the isolate exists, but the vendor process still never
 * starts on refusal.
 *
 * Consults pick() for who will actually run. An unpinned job that prefers
 * Codex is not refused because grok happens to be eligible; a pinned Codex
 * dispatch is not refused because grok's doctor is red.
 */
export function preflightMcp(opts: {
  mcp?: McpRequest
  cwd: string
  job: string
  prompt: string
  agent?: string
  avoid?: string[]
  distinctModels?: string[]
  model?: string
  probe?: boolean
  lens?: string
}): void {
  const mode = requestedMcpMode(opts.mcp)
  if (!mode) return
  const project = projectAt(opts.cwd)
  if (!project) return
  const malformed = validateStoredProjectSettings(project.settings)
  if (malformed.length) throw new Error(malformed.join('\n'))
  const { agent: name } = pick(
    opts.job, opts.agent, opts.prompt.length, true, stackAt(opts.cwd),
    { agents: opts.avoid, models: opts.distinctModels, model: opts.model },
    opts.probe,
    opts.lens,
  )
  const selected = AGENTS[name]!
  if (!job(opts.job).needs.readsRepo || selected.caps.discoversMcpFromCwd) {
    return
  }
  const connection = probeRequestedMcp(mode, name, opts.cwd)
  if (!connection) return
  const why = mcpAttachRefusal(connection)
  if (why && mode === 'require') throw new Error(why)
}

const warnedMainCheckouts = new Set<string>()

function warnMainCheckoutUntracked(path: string, warning: string): void {
  if (warnedMainCheckouts.has(path)) return
  warnedMainCheckouts.add(path)
  console.error(warning)
}

/**
 * Everything knowable BEFORE a row exists, checked where no row exists yet.
 *
 * Shared with `detach()`, which claims its placeholder row before the worker
 * process starts — so a precondition checked only inside `run()` still leaves a
 * row behind, and routing reads it as a failure. That happened twice: a
 * forgotten `--seed` was charged to codex as an implementation it could not
 * manage, and a depth refusal left two `(pending)` rows that later went stale.
 *
 * The rule this restores is already written at the top of `run()`: a run that
 * should not exist should not leave a row behind.
 */
export function preflight(
  jobName: string,
  cwd: string,
  seed?: string,
  key?: string,
  baseRef?: string,
  reusesWorktree = false,
  seedAlreadyValidated = false,
  lens?: string,
  reviewRef?: string,
  carry = false,
  repo?: string,
): string | undefined {
  if (depth() >= MAX_DEPTH) {
    throw new Error(
      `refusing to delegate at depth ${depth()}: this process is itself a delegated agent. ` +
        'Answer the question with the tools you have, or hand it back to the caller.',
    )
  }
  if (!reusesWorktree) {
    const named = repo?.trim() ? projectByName(repo) : projectAt(cwd)
    if (named) {
      const warning = assertMainCheckoutClean(named)
      if (warning) warnMainCheckoutUntracked(named.path, warning)
    }
  }
  const j = job(jobName)
  resolveReviewTarget(jobName, cwd, reviewRef, carry)
  const writesJob = Boolean(j.needs.writesRepo)
  if (j.findings && !lens?.trim()) {
    throw new Error(`${jobName} produces review findings and requires a stable lens identity.\n  --lens <id>`)
  }
  if (!j.findings && lens !== undefined) {
    throw new Error('--lens is only valid for jobs whose output is review findings')
  }
  if (lens && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(lens)) {
    throw new Error(`lens "${lens}" must be a lowercase stable id of at most 64 characters`)
  }
  if (lens) {
    resolveLens(lens, repo ?? projectAt(cwd)?.name ?? null)
  }
  const repoRoot = repoRootOf(cwd)
  if (jobName === 'review-lens' && repoRoot === null) {
    throw new Error(
      `a review lens reads a change, and ${cwd} is not inside a git checkout, so there is no change to read.\n` +
      `Run it from the checkout that holds the change.`,
    )
  }
  // The key belongs to the branch of a newly cut worktree. Inline jobs never
  // create that branch, so a project's branch template cannot require a key.
  const cutsWorktree = Boolean(j.needs.readsRepo)
  if (!cutsWorktree) return seed
  if (repoRoot === null) {
    throw new Error(`${jobName} reads a repository and ${cwd} is not a git checkout`)
  }
  if (!writesJob && seed !== undefined) {
    throw new Error('--seed is only valid for writing runs; seeds belong to writing runs')
  }
  // A key is required only when a writing worktree's branch template names it,
  // and a seed belongs only to a writing worktree. Read-only jobs bypass both
  // declarations. A resumed turn works in the tree its parent already has, so
  // demanding either again blocks every ruling.
  if (reusesWorktree) return seed
  const project = projectAt(cwd)
  if (project?.settings.worktree) assertRegisterBranches(project)
  const tool = project?.settings.worktree ?? null
  if (project) {
    const malformed = validateStoredProjectSettings(project.settings)
    if (malformed.length) throw new Error(malformed.join('\n'))
  }
  const effectiveSeed = seed
  const keyPattern = tool?.keyPattern ?? '^[A-Z][A-Z0-9]+-[0-9]+$'
  const problems: string[] = []
  if (key && !new RegExp(keyPattern).test(key)) {
    problems.push(`key "${key}" does not match ${keyPattern}`)
  }
  if (writesJob && tool?.create && !tool.branch) {
    problems.push(
      `this project's worktree create command has no branch template.\n` +
      `Set the worktree branch key with:\n` +
      `  orch project set ${project!.name} --settings '{"worktree":{"branch":"<template>"}}'`,
    )
  }
  if (writesJob && tool?.branch?.includes('{key}') && !key) {
    problems.push(
      `this project's branch names must carry a ticket key (${tool.branch}), and orch will ` +
      `not invent one.\n  --key <KEY-123>`,
    )
  }
  if (writesJob && tool?.seeds?.length && !effectiveSeed) {
    problems.push(
      `this project requires a database size for a new worktree, and has no default.\n` +
      `${seedGuidance(tool.seeds)}\n\n` +
      `Choosing is the architect's call: it depends on what the task touches.`,
    )
  } else if (writesJob && createHasPlaceholder(tool?.create, 'seed') && !effectiveSeed) {
    problems.push(
      `this project's worktree create arguments contain {seed}, so a seed is required.\n` +
      `  --seed <value>`,
    )
  }
  if (problems.length) throw new Error(problems.join('\n'))
  const selectedCreate = writesJob ? tool?.create : tool?.readonly_create
  if (project && selectedCreate && !createCommandExists(selectedCreate, project.path)) {
    const command = typeof selectedCreate === 'object' && 'command' in selectedCreate
      ? selectedCreate.command
      : 'sh'
    throw new Error(
      `project ${project.name} worktree create command ${command} is absent or not executable`,
    )
  }
  if (writesJob && tool?.create && !seedAlreadyValidated) validateSeedWithTool(cwd, effectiveSeed)
  return effectiveSeed
}

/**
 * Chain roots, not rows: every turn of a resumed chain records the same
 * worktree (eleven rows for one tree in the live store), and the exemption
 * asks whether ONE chain owns the tree.
 */
function recordedChainRootsForWorktree(path: string): number[] {
  const real = realpathOrSpelled(path)
  const rows = real === path
    ? db().query('SELECT COALESCE(parent_run_id, id) AS root FROM run WHERE worktree = ?')
        .all(path) as { root: number }[]
    : db().query('SELECT COALESCE(parent_run_id, id) AS root FROM run WHERE worktree = ? OR worktree = ?')
        .all(path, real) as { root: number }[]
  return [...new Set(rows.map((row) => row.root))]
}

/**
 * The caller-at-trunk exemption is granted from explicit resume identity only:
 * the chain being resumed, or a --base / --cwd that resolves to exactly one
 * recorded run's worktree path or branch tip. Equality is realpath or commit,
 * never a suffix, and never a table scan (DEV-318).
 */
export function namesRecordedRunTree(opts: {
  cwd: string
  explicitCwd?: boolean
  base?: string
  resume?: { parent: number; worktree: { path: string } | null }
}): boolean {
  if (opts.resume) {
    const row = db().query('SELECT worktree FROM run WHERE id = ?').get(opts.resume.parent) as
      { worktree: string | null } | null
    const recorded = row?.worktree ?? opts.resume.worktree?.path
    if (!recorded) return false
    return realpathOrSpelled(recorded) === realpathOrSpelled(opts.cwd)
  }
  if (opts.explicitCwd) return recordedChainRootsForWorktree(opts.cwd).length === 1
  if (!opts.base) return false
  const roots = new Set(
    (db().query('SELECT COALESCE(parent_run_id, id) AS root FROM run WHERE branch = ?')
      .all(opts.base) as { root: number }[]).map((row) => row.root),
  )
  try {
    const oid = resolveBase(opts.cwd, opts.base)
    const byCommit = db().query('SELECT COALESCE(parent_run_id, id) AS root FROM run WHERE head_commit = ?')
      .all(oid) as { root: number }[]
    for (const row of byCommit) roots.add(row.root)
  } catch { /* --base is not a commit here */ }
  return roots.size === 1
}

/**
 * Variables that may reach a vendor's CLI: an allowlist, not a denylist.
 *
 * childEnv() used to copy the whole environment minus CLAUDE_* and ANTHROPIC_*,
 * so a danger-full-access worker inherited every unrelated credential in the
 * session. CLAUDE_* and ANTHROPIC_* stay off the list for two reasons, both
 * load-bearing:
 *
 * IDENTITY. The child inherits this session's id, so an `orch` call it makes on
 * its own initiative is recorded as ours. The Stop hook then demands a score for
 * a run nobody in this session read — and an agent, told it is blocking, will
 * eventually score it. That is precisely the dishonest evidence the whole
 * scoring design exists to keep out, arriving through the door marked "never let
 * anyone else judge your runs".
 *
 * CREDENTIALS. An Anthropic key is metered billing — the one cost this layer
 * exists to avoid — and no external agent has any use for it. Handing it to a
 * third-party binary with a network connection of its own is a leak with no
 * upside.
 *
 * Allowed through: PATH, HOME, USER, SHELL, LANG, LC_*, TERM, TMPDIR, XDG_*,
 * SSH_AUTH_SOCK, the vendor prefixes each CLI needs (OPENAI_*, XAI_*, GROK_*,
 * GEMINI_*, GOOGLE_*, CODEX_*, QWEN_*), and ORCH_*. Project envPrefix vars are
 * not: recipes and project tools run in orch's own process with its env, and
 * the vendor CLI needs none of the project's tokens. MCP servers read their
 * own tokens from ~/.claude/.env inside mcp-run.
 *
 * Residual exposure: HOME on the allowlist means a full-access worker can
 * still read that file.
 */
const ALLOW_ENV_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'SSH_AUTH_SOCK',
])
const ALLOW_ENV_PREFIX =
  /^(LC_|XDG_|OPENAI_|XAI_|GROK_|GEMINI_|GOOGLE_|CODEX_|QWEN_|ORCH_)/

function childEnv(
  a: (typeof AGENTS)[string], runId?: number, runToken?: string,
  extra: Record<string, string> = {}, includeStore = true,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || !(ALLOW_ENV_EXACT.has(k) || ALLOW_ENV_PREFIX.test(k))) continue
    env[k] = v
  }
  env.ORCH_DEPTH = String(depth() + 1)
  /**
   * Which run is asking, for the ask-server the child may call back into.
   *
   * Set HERE, by the process that spawned the agent, because that is the only
   * party that actually knows. A worker naming its own run id would be guessing,
   * and in a fan-out several are alive at once — so the guess would sometimes
   * attach a question to another worker's run, and the ruling would be delivered
   * to whichever of them happened to be waiting.
   */
  if (runId) env.ORCH_RUN_ID = String(runId)
  // The credential half. The id says which run; this says the caller is
  // actually that run, and the environment of a child process is the one place
  // an unrelated process cannot read it from.
  if (runToken) env.ORCH_RUN_TOKEN = runToken
  /**
   * THE REAL DATABASE, not the one beside whatever checkout the worker is in.
   *
   * The parent has already resolved the one database through ORCH_DB, git's
   * common directory, or the main binary. Passing the absolute result keeps a
   * detached worker on that same file even after its cwd changes to a worktree.
   *
   * Reported by a worker that checked the command before building on it, which
   * is exactly the behaviour the contract asks for and exactly how this was
   * found.
   *
   * Residual exposure: the canon accepts that a worktree worker reads the real
   * register.
   */
  if (includeStore) env.ORCH_DB = DB_PATH
  const child = { ...env, ...(a.env?.() ?? {}), ...extra }
  if (!includeStore) delete child.ORCH_DB
  return child
}

/**
 * Children alive right now, so a signal can take them down with us.
 *
 * Without this, SIGTERM to `orch do` leaves the agent reparented to init with
 * nobody left to record what it did: the row claims to be running for ever, and
 * a subscription keeps being spent on an answer no one will read.
 */
const live = new Set<{ kill(sig?: number | string): void }>()
type LiveProcess = { kill(sig?: number | string): void }
type LiveCheckpoint = {
  runId: number
  rootId: number
  worktree: string
  branch: string
  taskKey: string
  scratchDir: string
  guardEnvironment: NodeJS.ProcessEnv
}
const liveCheckpoints = new Map<LiveProcess, LiveCheckpoint>()

/** Terminate the process pair recorded for a run, while allowing its coordinator to survive. */
export function terminateRunProcesses(id: number, exclude: number[] = []): number[] {
  const row = db().query('SELECT pid, agent_pid FROM run WHERE id=?').get(id) as
    { pid: number | null; agent_pid: number | null } | null
  if (!row) throw new Error(`no run ${id}`)
  const skipped = new Set(exclude)
  const pids = [...new Set([row.agent_pid, row.pid]
    .filter((pid): pid is number => Boolean(pid) && !skipped.has(pid!)))]
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
    }
  }
  return pids
}
let signalsBound = false
let terminating = false

function bindSignals() {
  if (signalsBound) return
  signalsBound = true
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (terminating) return
      terminating = true
      // Preserve the old delayed exit as the hard fallback, widened to the
      // coordinator's five-second shutdown bound while final checkpoints run.
      setTimeout(() => process.exit(130), 5_000)
      for (const p of live) { try { p.kill('SIGTERM') } catch { /* already gone */ } }
      for (const checkpoint of liveCheckpoints.values()) {
        const result = checkpointRun({
          database: db(), runId: checkpoint.runId, worktree: checkpoint.worktree,
          branch: checkpoint.branch, taskKey: checkpoint.taskKey,
          scratchDir: checkpoint.scratchDir,
          guardEnvironment: checkpoint.guardEnvironment, final: true,
        })
        if (result.created || latestCheckpoint(db(), checkpoint.rootId)) {
          db().query('UPDATE run SET work_preserved=1 WHERE id=?').run(checkpoint.runId)
        }
        if (result.error) {
          console.error(`orch: run ${checkpoint.runId} final checkpoint failed: ${result.error}`)
        }
      }
      // The `finally` in run() writes the terminal row; give it the turn it
      // needs before the process goes away.
      setTimeout(() => process.exit(130), 250)
    })
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/**
 * Keep BOTH ENDS of a failing agent's output.
 *
 * Neither end alone is enough, and each was tried. A head-side cut stored the
 * banner and the echoed prompt and threw the error away: runs 24, 26, 27 and 32
 * are 2000 characters of a review prompt with no indication of what went wrong,
 * and are permanently undiagnosable. A tail-side cut loses the other half — the
 * banner an agent prints before it does anything names the version, the model,
 * the provider, the sandbox and the approval mode, and that is frequently the
 * whole explanation. Run 243 is diagnosable only because its banner survived.
 *
 * So the head gets a quarter and the tail the rest, with the gap marked. The
 * prompt is stored separately anyway, which is what makes the echoed copy in
 * the middle the right thing to drop.
 */
export function errorTail(blob: string, limit = 2000): string {
  const t = blob.trim()
  if (t.length <= limit) return t
  const head = Math.floor(limit / 4)
  const tail = limit - head
  return `${t.slice(0, head)}\n… [${t.length - limit} characters omitted] …\n${t.slice(t.length - tail)}`
}

/**
 * Which project a directory belongs to, ASKED rather than inferred.
 *
 * This was `/Users/<someone>/Projects/<name>`, which is a fact about one
 * laptop written into the router. It worked, and it is also the single line
 * that made this tool unadoptable: nobody else's machine looks like that, and
 * the failure would be silent — an unrecognised layout yields `null`, which
 * reads as "no project" rather than as "this tool has never been told where
 * anything is".
 *
 * The register answers it now, by containment, so a worktree under
 * `<repo>/.claude/worktrees/orch-123` resolves to its project with no special
 * case at all — which the regex never did.
 */
export function repoOf(cwd: string): string | null {
  return projectAt(cwd)?.name ?? null
}

/**
 * The branch the work was on, recorded because it is free evidence about WHAT
 * the run was for and it was being thrown away.
 *
 * 53 of this estate's 60 branches carry a ticket key, and a branch name is a
 * declaration in exactly the way a worktree path is - somebody named it before
 * the work started. It is not a general answer: three main checkouts all sit on
 * `develop`, and a run from a main checkout is
 * precisely the one that has no key today. So this helps where the checkout is
 * on a ticket branch and is honestly silent otherwise.
 *
 * Read once, at claim time, and never allowed to fail a run: a directory that
 * is not a git repo, or a git that is slow, must cost nothing.
 */
function gitContext(cwd: string, ...args: string[]): string | null {
  try {
    const p = Bun.spawnSync(['git', '-C', cwd, ...args],
      { env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'ignore' })
    if (p.exitCode !== 0) return null
    const value = new TextDecoder().decode(p.stdout).trim()
    return value ? value.slice(0, 200) : null
  } catch { return null }
}

function reviewChangedPaths(cwd: string, base: string, inputTree: string): string[] {
  const args = ['diff', '--name-only', `${base}..${inputTree}`]
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], {
    env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    throw new Error(
      `could not measure explicit review paths with git ${args.join(' ')}: ` +
      (p.stderr.toString().trim() || `exit ${p.exitCode}`),
    )
  }
  return p.stdout.toString().trim().split('\n').filter(Boolean)
}

function checkoutRootAsAddressed(cwd: string): string | null {
  try {
    const p = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--show-prefix'], {
      env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'ignore',
    })
    if (p.exitCode !== 0) return null
    const prefix = new TextDecoder().decode(p.stdout).trim()
    let root = cwd
    for (const _segment of prefix.split('/').filter(Boolean)) root = dirname(root)
    return root
  } catch { return null }
}

type CheckoutAliases = {
  roots: string[]
  caseInsensitive: boolean
  diagnostic: string | null
}

function gitTopLevel(cwd: string): string | null {
  try {
    const p = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], {
      env: targetGitEnvironment(cwd), stdout: 'pipe', stderr: 'ignore',
    })
    if (p.exitCode !== 0) return null
    return new TextDecoder().decode(p.stdout).trim() || null
  } catch { return null }
}

function flipOneAsciiLetter(value: string): string | null {
  let index = -1
  for (let candidate = value.length - 1; candidate >= 0; candidate--) {
    if (/[A-Za-z]/.test(value[candidate]!)) {
      index = candidate
      break
    }
  }
  if (index === -1) return null
  const letter = value[index]!
  const flipped = letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()
  return value.slice(0, index) + flipped + value.slice(index + 1)
}

export function checkoutAliases(cwd: string): CheckoutAliases | null {
  const addressed = checkoutRootAsAddressed(cwd)
  const top = gitTopLevel(cwd)
  if (!addressed || !top) return null
  let canonical: string
  try { canonical = realpathSync(addressed) } catch { canonical = top }
  const roots = [...new Set([addressed, top, canonical])]
  return { roots, ...checkoutCaseSensitivity(addressed) }
}

export function checkoutCaseSensitivity(root: string): Omit<CheckoutAliases, 'roots'> {
  const variant = flipOneAsciiLetter(root)
  let caseInsensitive = false
  let diagnostic: string | null = null
  const partialFoldLimit =
    'path matching uses a partial Unicode case fold; filesystem-specific folding beyond it is a known limit'
  if (!variant) {
    diagnostic = `checkout case-sensitivity probe indeterminate: root has no alphabetic character ` +
      `(${root}); ${partialFoldLimit}`
  } else {
    try {
      const original = statSync(root)
      const changed = statSync(variant)
      caseInsensitive = original.dev === changed.dev && original.ino === changed.ino
    } catch {
      diagnostic = `checkout case-sensitivity probe indeterminate: could not stat case variant of ` +
        `${root}; ${partialFoldLimit}`
    }
  }
  return { caseInsensitive, diagnostic }
}

export type CheckoutStatusSnapshot = {
  project: string
  path: string
  status: string
  head?: string | null
  expectedHead?: string | null
}

type CheckoutCandidates = {
  watched: CheckoutToWatch[]
  failures: FreezeFailure[]
}

/**
 * The checkouts a run is confined against: the registered main checkout of
 * the run's OWN project, plus the caller checkout it was dispatched from.
 *
 * It used to be every registered project. Measured on 2026-09-07 with the
 * harness-health surface: 25 runs escaped in one day, 4.9 hours of worker
 * time, and sixteen of them were a THIRD project's checkout changing (a
 * canon edit in adanim, a fixture removed in alephbeis, stopal's release step
 * moving develop to master) while a bottega worker that never touched it was
 * in flight. Every session on the machine was an unwitting adversary to every
 * other session's writers. A change in another project is not this run's
 * escape; `ownProject` null (no project resolved) keeps the wide set, since
 * an unregistered caller has no narrower fact to stand on.
 */
export function checkoutWatchSet(
  additional: CheckoutToWatch[] = [], activeWorktree?: string, ownProject: string | null | undefined = undefined,
): CheckoutCandidates {
  const active = activeWorktree ? realpathSync(activeWorktree) : null
  const watched: CheckoutToWatch[] = []
  const failures: FreezeFailure[] = []
  const seen = new Set<string>()
  const registered = projects()
    .filter(({ name }) => ownProject === undefined || ownProject === null || name === ownProject)
  for (const checkout of [
    ...registered.map(({ name, path, settings }) => ({
      project: name, path,
      expectedHead: typeof settings.trunk === 'string' ? settings.trunk : null,
    })),
    ...additional,
  ]) {
    let canonical: string
    try {
      canonical = realpathSync(checkout.path)
    } catch (error) {
      failures.push({
        ...checkout,
        error: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    if (canonical === active || seen.has(canonical)) continue
    seen.add(canonical)
    watched.push({ project: checkout.project, path: canonical, expectedHead: checkout.expectedHead ?? null })
  }
  return { watched, failures }
}

/**
 * Cheap observation of registered main checkouts, outside a run's worktree.
 *
 * The freeze is the observer: porcelain, tree hashes and HEAD together. The
 * exported surface stays snapshots-only for callers that only need porcelain.
 */
export function snapshotRegisteredCheckouts(
  additional: CheckoutToWatch[] = [],
): CheckoutStatusSnapshot[] {
  return freezeCheckouts(checkoutWatchSet(additional).watched).snapshots.map((snapshot) => ({
    project: snapshot.project,
    path: snapshot.path,
    status: snapshot.status,
    head: snapshot.head,
    expectedHead: snapshot.expectedHead,
  }))
}

/**
 * A pack is written before its disposable worktree exists, so callers naturally
 * name the checkout they are standing in. That path is an address, not review
 * content: once the tree has been copied, every occurrence must point at the
 * copy or an agent following the pack escapes the isolation boundary.
 */
const UNICODE_ALPHANUMERIC_OR_MARK = /[\p{L}\p{N}\p{M}]/u
const PATH_NAME_CHARACTER = /[\p{L}\p{N}\p{M}_.-]/u
const SHELL_PATH_BOUNDARY = /[;&|<>()`$]/

/**
 * A deliberately partial subset of Unicode CaseFolding.txt's full (`F`)
 * mappings: dotted I, sharp S, and the Latin Alphabetic Presentation Forms.
 * JavaScript exposes no full case-fold operation. These cover the observed
 * length-changing filesystem folds without adding generated data or a runtime
 * dependency. Filesystem-specific folding beyond this table is a known limit.
 */
const PARTIAL_FULL_CASE_FOLD = new Map([
  ['İ', 'i\u0307'], ['ß', 'ss'], ['ẞ', 'ss'],
  ['ﬀ', 'ff'], ['ﬁ', 'fi'], ['ﬂ', 'fl'], ['ﬃ', 'ffi'], ['ﬄ', 'ffl'],
  ['ﬅ', 'st'], ['ﬆ', 'st'],
])

function partialUnicodeCaseFold(value: string): string {
  return [...value.normalize('NFC')]
    .map((character) => PARTIAL_FULL_CASE_FOLD.get(character) ?? character.toLowerCase())
    .join('').normalize('NFC')
}

function characterAt(value: string, offset: number): string | undefined {
  const point = value.codePointAt(offset)
  return point === undefined ? undefined : String.fromCodePoint(point)
}

function characterBefore(value: string, offset: number): string | undefined {
  if (offset <= 0) return undefined
  const last = value.charCodeAt(offset - 1)
  const start = last >= 0xDC00 && last <= 0xDFFF ? offset - 2 : offset - 1
  return value.slice(Math.max(0, start), offset)
}

function hasPathEndBoundary(prompt: string, offset: number): boolean {
  const after = characterAt(prompt, offset)
  if (after === undefined || after === '/' || /\s/.test(after)) return true
  if (SHELL_PATH_BOUNDARY.test(after)) return true
  if (UNICODE_ALPHANUMERIC_OR_MARK.test(after)) return false
  const next = characterAt(prompt, offset + after.length)
  return next === undefined || /\s/.test(next)
}

function pathRootMatchLength(
  prompt: string, offset: number, root: string, caseInsensitive: boolean,
): number | null {
  if (!caseInsensitive) {
    if (prompt.slice(offset, offset + root.length) !== root) return null
    return hasPathEndBoundary(prompt, offset + root.length) ? root.length : null
  }
  const foldedRoot = partialUnicodeCaseFold(root)
  let end = offset
  while (end < prompt.length) {
    const character = characterAt(prompt, end)!
    end += character.length
    const foldedCandidate = partialUnicodeCaseFold(prompt.slice(offset, end))
    if (foldedCandidate === foldedRoot) {
      return hasPathEndBoundary(prompt, end) ? end - offset : null
    }
    const following = characterAt(prompt, end)
    if (foldedCandidate.length >= foldedRoot.length &&
        !(following && /\p{M}/u.test(following))) return null
  }
  return null
}

function hasPathStartBoundary(prompt: string, offset: number): boolean {
  if (offset === 0) return true
  const before = characterBefore(prompt, offset)!
  return before !== '/' && !PATH_NAME_CHARACTER.test(before)
}

type RetargetResult = { prompt: string; diagnostic: string | null }
type RetargetAlias = { root: string; role: 'source' | 'target' }

function aliasKey(root: string, caseInsensitive: boolean): string {
  return caseInsensitive ? partialUnicodeCaseFold(root) : root
}

function invalidRetargeting(
  callers: string[], targets: string[], caseInsensitive: boolean,
): string | null {
  if (targets[0] === '') return 'review path retargeting indeterminate: destination is empty'
  const malformed = [...callers, ...targets].find((root) => root.startsWith('//'))
  if (malformed) return `review path retargeting indeterminate: unsupported alias ${malformed}`
  const normalizedCallers = callers.map(withoutTrailingSeparators)
  const normalizedTargets = targets.filter(Boolean).map(withoutTrailingSeparators)
  if (normalizedCallers.some((root) => root === '/')) {
    return 'review path retargeting indeterminate: caller alias is filesystem root (/)'
  }
  const sourceKeys = new Set(normalizedCallers.map((root) => aliasKey(root, caseInsensitive)))
  const collision = normalizedTargets.find((root) => sourceKeys.has(aliasKey(root, caseInsensitive)))
  return collision
    ? `review path retargeting indeterminate: alias has both source and target roles (${collision})`
    : null
}

function uriAuthorityEnd(prompt: string, offset: number): number | null {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(prompt.slice(offset))
  if (!scheme) return null
  let end = offset + scheme[0].length
  while (end < prompt.length && !/[\/?#\s'"`)\]}>]/.test(prompt[end]!)) end++
  return end
}

export function retargetRepositoryPrompt(
  prompt: string, callers: string | string[], worktree: string,
  caseInsensitive: boolean, protectedWorktreeRoots: string[],
): RetargetResult {
  const callerList = (Array.isArray(callers) ? callers : [callers])
  if (callerList.every((root) => root === '')) return { prompt, diagnostic: null }
  const rawTargets = [worktree, ...protectedWorktreeRoots]
  const invalid = invalidRetargeting(callerList, rawTargets, caseInsensitive)
  if (invalid) return { prompt, diagnostic: invalid }
  const aliases: RetargetAlias[] = [
    ...callerList.filter(Boolean).map((root) =>
      ({ root: withoutTrailingSeparators(root), role: 'source' as const })),
    ...rawTargets.filter(Boolean).map((root) =>
      ({ root: withoutTrailingSeparators(root), role: 'target' as const })),
  ].filter((alias, index, all) => all.findIndex((other) =>
    other.role === alias.role &&
    aliasKey(other.root, caseInsensitive) === aliasKey(alias.root, caseInsensitive)) === index)
    .sort((a, b) => aliasKey(b.root, caseInsensitive).length -
      aliasKey(a.root, caseInsensitive).length)
  const destination = withoutTrailingSeparators(worktree)
  let rewritten = ''
  let cursor = 0
  let authorityPathStart: number | null = null
  while (cursor < prompt.length) {
    const uriEnd = uriAuthorityEnd(prompt, cursor)
    if (uriEnd !== null) {
      rewritten += prompt.slice(cursor, uriEnd)
      cursor = uriEnd
      authorityPathStart = uriEnd
      continue
    }
    if (cursor !== authorityPathStart && !hasPathStartBoundary(prompt, cursor)) {
      rewritten += prompt[cursor++]
      continue
    }
    authorityPathStart = null
    const matched = aliases.map((alias) => ({
      alias,
      length: pathRootMatchLength(prompt, cursor, alias.root, caseInsensitive),
    })).find(({ length }) => length !== null)
    if (matched) {
      const { alias, length } = matched
      rewritten += alias.role === 'source'
        ? (destination === '/' && prompt[cursor + length!] === '/' ? '' : destination)
        : prompt.slice(cursor, cursor + length!)
      cursor += length!
      continue
    }
    rewritten += prompt[cursor++]
  }
  return { prompt: rewritten, diagnostic: null }
}

/** A dispatch may consume only a determinate retargeting result. */
export function retargetRepositoryPromptForDispatch(
  prompt: string, callers: string | string[], worktree: string,
  caseInsensitive: boolean, protectedWorktreeRoots: string[],
): string {
  const result = retargetRepositoryPrompt(
    prompt, callers, worktree, caseInsensitive, protectedWorktreeRoots,
  )
  if (result.diagnostic) throw new Error(result.diagnostic)
  return result.prompt
}

function boundedConfinementError(message: string): string {
  const bytes = Buffer.from(message)
  if (bytes.length <= 1500) return message
  const suffix = Buffer.from('\n… [error bounded to 1500 bytes]')
  return Buffer.from(bytes.subarray(0, 1500 - suffix.length))
    .toString('utf8').replace(/\uFFFD$/, '') + suffix.toString()
}

function confinementUnverifiedError(failures: FreezeFailure[]): string {
  return boundedConfinementError(
    'checkout confinement could not be verified:\n' + failures.map((failure) =>
      `registered checkout ${failure.project} at ${failure.path}: ${failure.error}`,
    ).join('\n'),
  )
}

function branchOf(cwd: string): string | null {
  const branch = gitContext(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')
  return branch && branch !== 'HEAD' ? branch : null
}

/**
 * Find one recorded ticket key in a deliberate context name.
 *
 * A name with no matching key is silent. A name with two is silent too: choosing
 * between two real-looking addresses would be guessing, and a wrong attribution
 * is worse than null. Project prefixes narrow the candidates where the register
 * declares them; the worktree key pattern remains the final validity check.
 */
function keyIn(name: string, cwd: string): string | null {
  const project = projectAt(cwd)
  const prefixes = project?.settings.keyPrefixes
  const prefix = prefixes?.length
    ? `(?:${prefixes.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`
    : '[A-Z][A-Z0-9]+'
  const candidates = name.match(new RegExp(`(?:^|[^A-Z0-9])(${prefix}-[0-9]+)(?=$|[^A-Z0-9])`, 'g'))
    ?.map((candidate) => candidate.match(new RegExp(`(${prefix}-[0-9]+)`))?.[1])
    .filter((candidate): candidate is string => Boolean(candidate)) ?? []
  const keyPattern = project?.settings.worktree?.keyPattern ?? '^[A-Z][A-Z0-9]+-[0-9]+$'
  const valid = [...new Set(candidates.filter((candidate) => new RegExp(keyPattern).test(candidate)))]
  return valid.length === 1 ? valid[0]! : null
}

/** Attribution for a read-only root: worktree name first, then branch. */
export function inferredReadOnlyKey(cwd: string): string | null {
  const top = gitContext(cwd, 'rev-parse', '--show-toplevel')
  const fromWorktree = top ? keyIn(basename(top), cwd) : null
  return fromWorktree ?? keyIn(branchOf(cwd) ?? '', cwd)
}

/**
 * How long a run's prompt and reply are kept on disk.
 *
 * These files are the whole text of every pack sent and every answer returned —
 * private repo contents, quoted at length — and nothing had ever deleted one.
 * The dashboard reads them to show a run in full, which is worth having while
 * the run is recent enough for anyone to care; a pack from two months ago is
 * just a copy of source code sitting outside the repo that governs it.
 *
 * The database keeps the row either way, so history and scoring are untouched:
 * only the verbatim text ages out, and `runDetail` already copes with a path
 * that no longer exists.
 */
export const KEEP_RUN_FILES_DAYS = 30

/**
 * Where prompt and output files live. By default they sit beside the resolved
 * database, so a worktree cannot strand its evidence when it is swept.
 * ORCH_RUNS remains the deliberate override used by the suite.
 */
export const RUNS_DIR = resolveRunsDirectory()

/** The names owned by one run; `unique` is its id once a row has been claimed. */
export function runFilePaths(
  dir: string, clock: number, unique: number | string, agent: string, jobName: string,
) {
  const stamp = `${clock}-${unique}-${agent}-${jobName}`
  return {
    output: join(dir, `${stamp}.txt`),
    prompt: join(dir, `${stamp}.prompt.txt`),
  }
}

/** Opportunistic, on the way past: cheap, and no cron has to remember. */
export function pruneRuns(dir: string): void {
  const cutoff = Date.now() - KEEP_RUN_FILES_DAYS * 86_400_000
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.mtimeMs < cutoff) {
          if (st.isDirectory()) rmSync(p, { recursive: true, force: true })
          else unlinkSync(p)
          db().query('UPDATE run SET prompt_path=NULL WHERE prompt_path=?').run(p)
          db().query('UPDATE run SET output_path=NULL WHERE output_path=?').run(p)
        }
      } catch { /* raced, or busy */ }
    }
  } catch { /* no directory yet; nothing to prune */ }
}

export function runScratchDir(id: number, runsDir = RUNS_DIR): string {
  return join(runsDir, String(id), 'scratch')
}

export function noRepoIsolatePath(id: number, runsDir = RUNS_DIR): string {
  return join(runsDir, 'isolates', String(id))
}

export function runArtifactsDir(id: number, runsDir = RUNS_DIR): string {
  return join(runsDir, String(id), 'artifacts')
}

export function declaredDeliverablesPath(id: number, runsDir = RUNS_DIR): string {
  return join(runsDir, String(id), 'deliverables.json')
}

export function runTerminalResultPath(id: number, runsDir = RUNS_DIR): string {
  return join(runsDir, String(id), 'result.json')
}

export function runTerminalReplyPath(id: number, runsDir = RUNS_DIR): string {
  return join(runsDir, String(id), 'reply.txt')
}

export type TerminalSnapshot = {
  status: string
  error: string | null
  failureKind: string | null
  output: string
  outputPath: string
  promptPath: string
  exitCode: number | null
  latencyMs: number
  vendorTokens: number | null
  vendorCostUsd: number | null
  model: string | null
  vendorSession: string | null
  preConfinement: string | null
  confinement: string | null
  filesChanged: number | null
  changedPaths: string | null
  linesAdded: number | null
  linesRemoved: number | null
  testsRan: number | null
  testsPassed: number | null
  deviations: number | null
  escalations: number | null
}

export function persistTerminalSnapshot(id: number, snapshot: TerminalSnapshot): void {
  mkdirSync(join(RUNS_DIR, String(id)), { recursive: true })
  writeFileSync(runTerminalReplyPath(id), snapshot.output)
  writeFileSync(runTerminalResultPath(id), JSON.stringify(snapshot))
}

export function readTerminalSnapshot(id: number): TerminalSnapshot | null {
  const path = runTerminalResultPath(id)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as TerminalSnapshot
  } catch {
    return null
  }
}

/** Record a terminal row from the run directory after a schema-reload failure. */
export function reconcileRun(id: number): string {
  writableDb()
  const snapshot = readTerminalSnapshot(id)
  if (!snapshot) {
    throw new Error(
      `run ${id} has no persisted terminal snapshot\n` +
      `invariant: ${CONNECTION_SCHEMA_INVARIANT}\n` +
      `cleared by: the worker must persist reply.txt and result.json before the row write`,
    )
  }
  const row = db().query('SELECT id, unreconciled, status FROM run WHERE id=?').get(id) as
    { id: number; unreconciled: number; status: string } | null
  if (!row) throw new Error(`no run ${id}`)
  writeTransaction(() => {
    db().query(
      `UPDATE run SET latency_ms=?, exit_code=?, output_bytes=?, output_path=?, prompt_path=?,
                      vendor_tokens=?, vendor_cost_usd=?, model=COALESCE(?, model),
                      status=?, error=?, failure_kind=?, vendor_session=COALESCE(?, vendor_session),
                      pre_confinement=?, confinement=?, unreconciled=0,
                      files_changed=?, changed_paths=?, lines_added=?, lines_removed=?,
                      tests_ran=?, tests_passed=?, deviations=?, escalations=?
        WHERE id=?`,
    ).run(
      snapshot.latencyMs, snapshot.exitCode,
      new TextEncoder().encode(snapshot.output).byteLength,
      snapshot.outputPath, snapshot.promptPath,
      snapshot.vendorTokens, snapshot.vendorCostUsd, snapshot.model,
      snapshot.status, snapshot.error, snapshot.failureKind, snapshot.vendorSession,
      snapshot.preConfinement, snapshot.confinement,
      snapshot.filesChanged, snapshot.changedPaths, snapshot.linesAdded, snapshot.linesRemoved,
      snapshot.testsRan, snapshot.testsPassed, snapshot.deviations, snapshot.escalations,
      id,
    )
  })
  teardownTerminalRunResources(db(), id)
  return `reconciled run ${id} as ${snapshot.status}`
}

export function listRunArtifacts(id: number, runsDir = RUNS_DIR): string[] {
  const dir = runArtifactsDir(id, runsDir)
  if (!existsSync(dir)) return []
  const names = readdirSync(dir, { recursive: true })
  const files: string[] = []
  for (const name of names) {
    const p = join(dir, String(name))
    try { if (statSync(p).isFile()) files.push(p) } catch { /* raced */ }
  }
  return files.sort()
}

type DispatchState = { deliverables: string[]; timeoutMinutes: number | null }

function writeDispatchState(id: number, state: DispatchState): void {
  mkdirSync(join(RUNS_DIR, String(id)), { recursive: true })
  writeFileSync(declaredDeliverablesPath(id), JSON.stringify(state))
}

export function readDispatchState(id: number): DispatchState {
  const p = declaredDeliverablesPath(id)
  if (!existsSync(p)) return { deliverables: [], timeoutMinutes: null }
  try {
    const value = JSON.parse(readFileSync(p, 'utf8')) as Partial<DispatchState> | string[]
    if (Array.isArray(value)) {
      return {
        deliverables: value.every((item) => typeof item === 'string') ? value : [],
        timeoutMinutes: null,
      }
    }
    const deliverables = Array.isArray(value.deliverables) &&
      value.deliverables.every((item) => typeof item === 'string') ? value.deliverables : []
    const timeoutMinutes = typeof value.timeoutMinutes === 'number' ? value.timeoutMinutes : null
    return { deliverables, timeoutMinutes }
  } catch { return { deliverables: [], timeoutMinutes: null } }
}

export function readDeclaredDeliverables(id: number): string[] {
  return readDispatchState(id).deliverables
}

/** Present reply.json is accepted by the same lenient parsers as a missing-file fallback. */
function presentReplyFileMatches(opts: {
  text: string
  schema: unknown
  customSchema: boolean
  writesJob: boolean
  issueWorker: boolean
  findings: boolean
  reader: boolean
}): boolean {
  const schema = opts.schema as Parameters<typeof validatesSchema>[1]
  if (opts.customSchema) {
    let value: unknown
    try { value = JSON.parse(opts.text) } catch { return false }
    return validatesSchema(value, schema)
  }
  if (opts.writesJob) {
    return parseWorkerReplyWithCount(
      opts.text, opts.issueWorker ? ISSUE_WORKER_SCHEMA : WORKER_SCHEMA,
    ).reply !== null
  }
  if (opts.findings) return parseReviewOutput(opts.text) !== null
  if (opts.reader) return parseReaderOutput(opts.text) !== null
  let value: unknown
  try { value = JSON.parse(opts.text) } catch { return false }
  return validatesSchema(value, schema)
}

function persistRunArtifacts(
  id: number,
  filesWritten: string[] | null,
  worktree: Worktree | null,
  changes: import('./worktree.ts').Changes | null,
): void {
  const scratch = runScratchDir(id)
  const artifacts = runArtifactsDir(id)
  mkdirSync(join(RUNS_DIR, String(id)), { recursive: true })
  if (existsSync(scratch)) {
    if (existsSync(artifacts)) rmSync(artifacts, { recursive: true, force: true })
    renameSync(scratch, artifacts)
  } else {
    mkdirSync(artifacts, { recursive: true })
  }
  if (changes?.diff) writeFileSync(join(artifacts, 'worktree.diff'), changes.diff)
  for (const named of filesWritten ?? []) {
    const source = named.startsWith('/') ? named
      : worktree ? join(worktree.path, named) : named
    const destination = join(artifacts, basename(named))
    // Scratch was renamed onto artifacts above. A files_written path that still
    // names the old scratch location (reply.json is the usual case) already
    // lives at the destination.
    const from = source === scratch || source.startsWith(`${scratch}/`)
      ? join(artifacts, relative(scratch, source))
      : source
    if (from === destination && existsSync(destination) && statSync(destination).isFile()) continue
    if (!existsSync(from) || !statSync(from).isFile()) {
      throw new Error(`could not copy named file ${source} to ${destination}: source is not a file`)
    }
    copyFileSync(from, destination)
  }
}

function reclaimTerminalTree(runId: number, worktree: Worktree): void {
  try {
    const identity = { session: sessionId(), what: `terminal reclaim ${runId}` }
    withWorktreeLease(worktree.repoRoot, worktree.path, identity, () => {
      withCleanupLock(worktree.repoRoot, identity, () => {
        const result = removeFor(worktree, worktree.repoRoot, true, false, runId, false)
        if (!result.removed) {
          console.error(`orch: could not reclaim worktree for run ${runId}: ${result.detail}`)
          return
        }
        db().query('UPDATE run SET worktree=NULL WHERE id=? AND worktree=?')
          .run(runId, worktree.path)
      })
    })
  } catch (e) {
    console.error(`orch: could not reclaim worktree for run ${runId}: ${e}`)
  }
}

/**
 * The prompt a resumed turn actually puts on argv — reminder, separators,
 * resume guard, and the turn body — so the bound can be checked against the
 * same bytes the agent will receive.
 */
export function packedResumePrompt(job: string, turnPrompt: string, parentId: number): string {
  const root = db().query('SELECT prompt_path FROM run WHERE id=?').get(parentId) as
    { prompt_path: string | null } | null
  // A root whose prompt has aged out of runs/ (30 days) is still
  // resumable: the reminder is a courtesy to the worker, not a
  // precondition, and refusing here would strand the chain.
  if (!root?.prompt_path || !existsSync(root.prompt_path)) {
    return packResumePrompt(job, turnPrompt, null)
  }
  return packResumePrompt(job, turnPrompt, readFileSync(root.prompt_path, 'utf8'))
}

export async function run(opts: {
  job: string
  prompt: string
  agent?: string
  schemaPath?: string
  mcp?: McpRequest
  /** A calibration probe: recorded and scorable, but never routing evidence. */
  probe?: boolean
  /** A caller-supplied name for distinguishing sibling runs in a fan-out. */
  label?: string
  /** Stable identity used to calibrate findings-producing review jobs. */
  lens?: string
  model?: string
  /** Pilot opt-in. Default `cli`. */
  transport?: TransportName
  cwd?: string
  /** Explicit routing attribution when the caller is outside the registered project. */
  repo?: string
  /** The run this one re-attempts, for `orch retry`. */
  retryOf?: number
  noFailover?: boolean
  noWaitCapacity?: boolean
  ownerSession?: string | null
  automaticFailover?: boolean
  /**
   * How much database the worker's worktree gets, where the project asks.
   *
   * The ARCHITECT'S call, not the worker's, and not orch's. It depends on what
   * the task touches — docs need none, a migration needs every table, a report
   * needs the tables it reads — which is a fact about the design rather than
   * about the code, and the worker has not seen the design.
   */
  seed?: string
  /** A ticket key, where the project's branch convention requires one. */
  key?: string
  /** A caller-selected git floor, used only by lifecycle tools that accept it. */
  base?: string
  /** Fan-out diversity constraints, resolved by the CLI before a row exists. */
  avoid?: string[]
  distinctModels?: string[]
  /**
   * Carry the caller's uncommitted work into a newly cut worktree.
   *
   * Opt-in, default off. See the call site in this function for why.
   */
  carry?: boolean
  /** Branch or run id whose tip is the base of a findings review. */
  review?: string
  /**
   * A row already claimed by the caller, to be filled in rather than inserted.
   *
   * `orch do --detach` needs to print a run id BEFORE the work starts, which it
   * cannot do if the id is allocated in here after routing. So the caller
   * claims a placeholder row, hands the id over, and this fills it in once the
   * agent is picked.
   */
  reserveId?: number
  /**
   * Continue a worker that stopped to ask, instead of starting a new one.
   *
   * Threaded through `run()` rather than given its own function because
   * everything after the command line is identical — the same spawn, the same
   * timeout, the same reaping, the same `finally` that must write a terminal
   * row whatever happened. A second copy of that machinery would be a second
   * place for the bug this system has already had twice: a run that never says
   * it stopped.
   *
   * What a resume changes is only the front: no routing (the conversation
   * belongs to the agent that started it), no new worktree (the worker is
   * mid-edit in one), and `resumeArgv` in place of `argv`.
   */
  resume?: {
    parent: number
    agent: string
    session?: string
    /** Continue the chain and retained tree in a new vendor conversation. */
    fresh?: boolean
    turn: number
    /** Inherited so the chain stays owned by the session that started it. */
    sessionId: string | null
    worktree: Worktree | null
  }
  /** Declared reader deliverable names, from repeated `--deliverable`. */
  deliverables?: string[]
  /** `orch do --timeout` in minutes. */
  timeoutMinutes?: number
  /** Opt out of reclaim-at-terminalisation for lens and reader jobs. */
  keepTree?: boolean
  /** Immutable explicit-review target inherited only by automatic failover. */
  resolvedReviewTarget?: { branch: string; commit: string; base: string }
}): Promise<RunResult> {
  writableDb()
  enableSchemaReload(() => {})

  const requestedJob = job(opts.job)
  const inheritedDispatch = opts.resume ? readDispatchState(opts.resume.parent) : null
  const declaredDeliverables = opts.deliverables ?? inheritedDispatch?.deliverables ?? []
  const timeoutMinutes = opts.timeoutMinutes ?? inheritedDispatch?.timeoutMinutes ?? undefined
  const writesJob = Boolean(requestedJob.needs.writesRepo)
  const repoJob = Boolean(requestedJob.needs.readsRepo)
  const forbidsRepo = requestedJob.needs.readsRepo === false
  const requestedTransport = resolveRunTransport(opts)
  const callerCwd = opts.cwd ?? process.cwd()
  const seed = preflight(
    opts.job, callerCwd, opts.seed, opts.key, opts.base,
    opts.resume?.worktree != null,
    opts.reserveId !== undefined,
    opts.lens, opts.resolvedReviewTarget ? undefined : opts.review, opts.carry, opts.repo,
  )
  const reviewTarget = opts.resolvedReviewTarget ?? resolveReviewTarget(
    opts.job, opts.cwd ?? process.cwd(), opts.review, opts.carry,
  )
  const implicitCoverageBase = !reviewTarget && requestedJob.findings
    ? implicitReviewCoverageBase(callerCwd)
    : null
  const coverageBase = reviewTarget?.base ?? implicitCoverageBase
  // Programmatic callers get the same ordering guarantee as the CLI: a bad
  // ref is refused before a run row or worktree exists.
  if (opts.base) {
    const internalRepositoryFailover = opts.automaticFailover && requestedJob.needs.readsRepo
    if (opts.job !== 'implement' && opts.job !== 'fix' && opts.job !== 'land' && !internalRepositoryFailover) {
      throw new Error('--base is only valid for the implement, fix and land jobs')
    }
  }
  const readOnlyBase = repoJob && !writesJob && !opts.resume?.worktree
    ? resolveReadOnlyBase(callerCwd, reviewTarget?.commit ?? opts.base ?? 'HEAD')
    : null
  if (opts.base && readOnlyBase === null) resolveBase(callerCwd, opts.base)
  // REACHABILITY IS A ROUTING INPUT, not a run outcome, and this is the line
  // that makes it one. `available()` had only ever checked that an endpoint was
  // CONFIGURED, which stayed true while the local model host was powered off
  // — so routing kept handing it `file-question`, its best job, and kept
  // recording the failures against the model. One probe here costs 2ms when the
  // endpoint is healthy, and when it is not it replaces a run that was going to
  // fail anyway.
  //
  // Awaited before pick() so the router sees the result, and cached for the
  // process so a fan-out probes once rather than per run.
  const health = await ensureLocalHealth()
  // Down, so ask it to come back — and then carry on without it.
  //
  // A cold start is 5m42s measured (power-on to `Application startup complete`),
  // which no caller can wait for, so this is fire-and-continue: the packet goes
  // out, THIS job routes to a cloud agent as it would have anyway, and the next
  // one minutes later finds the endpoint up. Nothing is slower than it was; the
  // difference is that the outage now ends by itself.
  //
  // Opt-in via ORCH_LOCAL_WOL_MAC, because the box is shared and powering on
  // somebody else's machine is not a default worth assuming.
  if (!health.ok) {
    const woken = tryWake()
    if (woken.sent) {
      notify('waking the local box', `${woken.detail}. Serving again in ~6 minutes.`)
    }
  }
  /**
   * A writing job carries its role contract, and carries it HERE.
   *
   * The caller's prompt is stored unwrapped at prompt_path so `orch retry` can
   * re-send it and wrap once. The bound text — preamble plus prompt — is what
   * the agent is actually sent, hashed and routed, and is written beside it as
   * `.bound.txt`. Wrapping it further down would send a payload the database
   * no longer described.
   *
   * Whether a contract is required is derived from `writesRepo`: changing
   * files is where guessing becomes costly. Its role prose is selected by job,
   * because `land` deliberately permits the one commit that the ordinary
   * implementation contract forbids.
   */
  // A RESUMED turn does not repeat the full preamble. The worker is still inside
  // the conversation that carried it, so re-sending all of it would spend tokens
  // restating rules the agent is already operating under. A short reminder puts
  // the original plan back in view without storing another copy on every child.
  /**
   * The worker is TOLD about the infrastructure it has, in the project's own
   * words.
   *
   * A worker that does not know it can serve its own branch on its own port
   * verifies against whatever is already running — a different branch's bundle
   * — and that does not fail, it PASSES against the wrong tree. Which is worse
   * than failing, and is exactly the trap these projects wrote their worktree
   * scripts to close.
   */
  /**
   * What the worker is told about its tree — the project's own words where it
   * wrote them, and generated from the recipe where it did not.
   *
   * A project writing its own `notes` knows things bottega cannot. A project
   * that only declared a recipe should still not have to remember to warn a
   * worker never to verify against somebody else's server, so the facts bottega
   * does know are stated on its behalf.
   */
  const infra = (() => {
    if (!repoJob) return ''
    const tool = toolFor(opts.cwd ?? process.cwd())
    if (!tool) return ''
    if (!writesJob && (!tool.readonly_create || tool.readonly_notes !== undefined)) {
      const tree = tool.readonly_notes !== undefined
        ? `This read-only run has the project's files at ${readOnlyBase}. ${tool.readonly_notes}`
        : `This read-only run has the project's files at ${readOnlyBase} with NO provisioned ` +
          `infrastructure (no databases, no generated env, no vendor tree).`
      return `${tree} Do not treat a test suite that cannot start as a finding; ` +
        `record what you could not run in could_not_verify.`
    }
    const generated = tool.recipe
      ? recipeNotes(tool.recipe, '<this worktree\'s database>', '')
      : ''
    return [tool.notes ?? '', generated].filter(Boolean).join('\n\n')
  })()
  const originalPrompt = opts.prompt
  const generatedSchema = requestedJob.name === 'issue-worker'
    ? ISSUE_WORKER_SCHEMA
    : writesJob ? WORKER_SCHEMA
      : requestedJob.findings ? REVIEW_SCHEMA
        : requestedJob.name === 'verify-claim' ? VERIFY_CLAIM_SCHEMA
          : isReaderJob(opts.job) ? READER_SCHEMA : TEXT_REPLY_SCHEMA
  const replySchemaName = opts.schemaPath
    ? basename(opts.schemaPath)
    : requestedJob.name === 'issue-worker' ? 'ISSUE_WORKER_SCHEMA'
      : writesJob ? 'WORKER_SCHEMA'
        : requestedJob.findings ? 'REVIEW_SCHEMA'
          : requestedJob.name === 'verify-claim' ? 'VERIFY_CLAIM_SCHEMA'
            : isReaderJob(opts.job) ? 'READER_SCHEMA' : TEXT_REPLY_SCHEMA_NAME
  const runProjectName = opts.repo ?? repoOf(callerCwd)
  const runProjectId = runProjectName ? projectByName(runProjectName)?.id ?? null : null
  let pack: ReturnType<typeof compilePack> | null = null
  if (!opts.resume) {
    try {
      pack = compilePack({ job: opts.job, cwd: callerCwd })
      recordPack(pack)
    } catch (cause) {
      const message = (cause as Error).message
      let failedId = opts.reserveId
      if (failedId) db().query(
        `UPDATE run SET status='failed', failure_kind='harness', error=? WHERE id=?`,
      ).run(message, failedId)
      else failedId = (db().query(
        `INSERT INTO run (started_at,agent,job,repo,project_id,cwd,prompt_sha,spec_sha,prompt_bytes,prompt_head,
          status,session_id,failure_kind,error,docs_injected,mcp)
         VALUES (?,'(pending)',?,?,?,?,?,?,?,?,'failed',?,'harness',?,0,?) RETURNING id`,
      ).get(nowIso(), opts.job, runProjectName, runProjectId, callerCwd, sha(originalPrompt), sha(originalPrompt),
        Buffer.byteLength(originalPrompt), originalPrompt.slice(0, 200).replace(/\s+/g, ' '),
        opts.ownerSession ?? sessionId(), message, storedMcpRequest(opts.mcp)) as { id: number }).id
      throw Object.assign(new Error(`run ${failedId} could not start: ${message}`), { runId: failedId })
    }
  }
  const docsSection = pack?.docs.length
    ? `WHAT THE OPERATOR WANTS YOU TO KNOW\n\n${pack.markdown}`
    : ''
  let prompt = writesJob && (!opts.resume || opts.resume.fresh)
    ? [
        workerPreamble(opts.job),
        infra ? `\nYOUR WORKTREE'S INFRASTRUCTURE\n\n${infra}` : '',
        docsSection ? `\n${docsSection}` : '',
        `\n---\n\nTHE SPEC\n\n${originalPrompt}`,
      ].filter(Boolean).join('\n')
    // A read-only worker gets a much shorter brief, and only on a first turn.
    : opts.resume && !opts.resume.fresh
      ? packedResumePrompt(opts.job, originalPrompt, opts.resume.parent)
      : [repoJob ? READONLY_PREAMBLE : NO_REPO_PREAMBLE,
          infra ? `YOUR WORKTREE'S INFRASTRUCTURE\n\n${infra}` : '',
          docsSection, `---\n\n${originalPrompt}`]
          .filter(Boolean).join('\n\n')

  if (requestedJob.findings && (!opts.resume || opts.resume.fresh)) {
    prompt = `${REVIEW_SEVERITY_INSTRUCTION}\n\n${prompt}`
    const resolvedLens = resolveLens(opts.lens!, opts.repo ?? repoOf(callerCwd))
    if (resolvedLens) prompt += `\n\n${resolvedLens.body}`
    else console.error(`lens ${opts.lens}: no catalogue row; dispatching the free-form lens unchanged`)
  }
  if (isReaderJob(opts.job) && (!opts.resume || opts.resume.fresh)) {
    prompt = `${readerDeliverablesInstruction(declaredDeliverables)}\n\n${prompt}`
  }
  prompt = `${replyFileInstruction(replySchemaName)}\n\n${prompt}`

  const requiresCanonSource = requestedJob.findings || opts.job === 'verify-claim'

  // A resumed turn is NOT routed. The conversation lives inside one vendor's
  // session, so "which agent is best at this job" is not a question that can be
  // asked any more — re-routing would resume a session the new agent has never
  // seen. Recorded with a reason that says so, rather than an empty one.
  const { agent: name, reason } = opts.resume
    ? {
        agent: opts.resume.agent,
        reason: `resumed run ${opts.resume.parent} (turn ${opts.resume.turn}); ` +
          'repository path retargeting not applied because the turn is already bound to its worktree',
      }
    // The STACK steers the route: an agent strong on PHP and weak on a Vue
    // component is two different agents to a router, and only this tells them
    // apart. Backs off to job-wide evidence until a stack cell has earned it.
    : pick(opts.job, selectAgentForTransport(requestedTransport, opts.agent),
           Buffer.byteLength(prompt) + (requestedJob.findings ? CALIBRATION_SUFFIX_RESERVE_BYTES : 0) +
             (requiresCanonSource ? CANON_SOURCE_PROMPT_RESERVE_BYTES : 0),
           true, stackAt(callerCwd),
           { agents: opts.avoid, models: opts.distinctModels, model: opts.model,
             noWaitCapacity: opts.noWaitCapacity },
           opts.probe, opts.lens)
  const a = AGENTS[name]!
  let boundMs: number
  try {
    // A durable historical row can name an agent that is no longer registered.
    // Preserve the reserved resume row long enough for the existing harness
    // failure path to record that fact; timeout validation must not erase it.
    boundMs = resolveJobTimeoutMs(
      requestedJob,
      a?.timeoutMs ?? requestedJob.timeoutCeilingMs ?? 20 * 60_000,
      timeoutMinutes,
    )
  } catch (e) {
    if (opts.reserveId) db().query('DELETE FROM run WHERE id=?').run(opts.reserveId)
    throw e
  }
  if (!opts.resume) {
    const boundLine = `\n\n${jobBoundInstruction(requestedJob, boundMs)}`
    const split = prompt.lastIndexOf('\n---\n')
    prompt = split >= 0 ? prompt.slice(0, split) + boundLine + prompt.slice(split) : prompt + boundLine
  }
  const transportName = opts.resume || opts.transport !== undefined || process.env.ORCH_TRANSPORT
    ? requestedTransport
    : a.defaultTransport
  if (transportName === 'acp') {
    try {
      assertAcpAllowed(opts.job, name)
      if (!isTestTransportInstalled()) assertAcpReady(name)
    } catch (e) {
      if (opts.reserveId) db().query('DELETE FROM run WHERE id=?').run(opts.reserveId)
      throw e
    }
  }
  if (name === 'codex') {
    const versionRefusal = minimumCliVersionRefusal(a)
    if (versionRefusal) {
      if (opts.reserveId) db().query('DELETE FROM run WHERE id=?').run(opts.reserveId)
      throw new Error(versionRefusal)
    }
  }
  // Route first because the cell keys on the agent ACTUALLY selected. The
  // suffix reserve above keeps argv eligibility honest; append before any
  // prompt file, hash, or database prompt metadata is written.
  if (requestedJob.findings && !opts.resume) {
    const suffix = calibrationLine(reviewCalibration(opts.lens!, name, opts.model ?? a.model))
    if (Buffer.byteLength(suffix) > CALIBRATION_SUFFIX_RESERVE_BYTES) {
      throw new Error('review calibration line exceeded its reserved routing allowance')
    }
    prompt += `\n\n${suffix}`
  }

  /**
   * Probe after routing: a red grok doctor is evidence about grok, not about
   * Codex. Agents that discover MCP from cwd must be probed later, against the
   * worker tree they will actually inspect; all others retain the pre-row path.
   *
   * A reserved placeholder was claimed by detach() after the same check; if
   * routing here disagrees and grok cannot attach, delete that placeholder
   * rather than converting a non-event into a failed row.
   */
  const mcpMode = requestedMcpMode(opts.mcp)
  const deferredCwdMcpPreflight = Boolean(
    mcpMode && projectAt(callerCwd) && (forbidsRepo || (repoJob && a.caps.discoversMcpFromCwd)),
  )
  let mcpConnection = deferredCwdMcpPreflight
    ? null
    : probeRequestedMcp(opts.mcp, name, callerCwd)
  const mcpWhy = mcpConnection ? mcpAttachRefusal(mcpConnection) : null
  if (mcpWhy && mcpMode === 'require') {
    if (opts.reserveId) db().query('DELETE FROM run WHERE id=?').run(opts.reserveId)
    throw new Error(mcpWhy)
  }

  /** Whether the requested product is a diff, rather than review findings. */
  let usingMcp = (Boolean(mcpMode) || writesJob) && a.caps.mcp && mcpConnection?.connected !== false
  /**
   * Every repository job gets writable scratch space. `writesJob` still means
   * its requested product is a diff; `repoJob` means it needs an isolated tree
   * in which it may test a hypothesis.
   */
  const writes = repoJob

  // Minted before the spawn when the agent lets us choose, so the resume handle
  // exists even for a worker that dies mid-turn. codex and qwen name their own
  // and are read back afterwards instead.
  const vendorSession: string | null = opts.resume && !opts.resume.fresh
    ? opts.resume.session ?? null
    : a.mintSession?.() ?? null

  const runsDir = RUNS_DIR
  mkdirSync(runsDir, { recursive: true })
  pruneRuns(runsDir)
  /**
   * A RUN FILE IS NAMED BY ITS RUN, never by the clock alone.
   *
   * This was `${Date.now()}-${name}-${opts.job}`, and six review lenses fired
   * concurrently landed three of them inside the same millisecond with the same
   * agent and the same job — so three runs shared one prompt file and one output
   * file. Last write wins, so all three workers read whichever prompt was written
   * last and answered the same question; two of them were scored `none` by the
   * session that caught it, and it only caught it because the content did not
   * match what it had asked for.
   *
   * That is the worst shape a bug can have here: silent, confidently wrong, and
   * worse the more you parallelise — which is exactly the usage we encourage.
   * The run id is unique by construction, so it goes in the name. `claim` is the
   * reserved id for a detached run; a foreground run has none yet, and a random
   * suffix covers it without reintroducing a clock race.
   */
  const unique = opts.reserveId ?? `x${randomUUID().slice(0, 8)}`
  const paths = runFilePaths(runsDir, Date.now(), unique, name, opts.job)
  const stamp = paths.output.slice(runsDir.length + 1, -4)
  const outPath = paths.output
  const claimedPrompt = opts.reserveId
    ? (db().query('SELECT prompt_path FROM run WHERE id=?').get(opts.reserveId) as
        { prompt_path: string | null } | null)?.prompt_path
    : null
  const promptPath = claimedPrompt ?? paths.prompt
  writeFileSync(promptPath, originalPrompt)
  // Beside the prompt it wraps, whatever that file is called: a detached run's
  // prompt path was named by detach() before this stamp existed.
  writeFileSync(promptPath.replace(/\.prompt\.txt$/, '.bound.txt'), prompt)

  /**
   * The return contract, written to disk because that is how both agents take
   * one: codex's `--output-schema` wants a path and grok's `--json-schema`
   * wants the text, which agents.ts reads back from the same file.
   *
   * A caller's own `--schema` still wins. `orch do implement --schema mine.json`
   * is a deliberate act by someone who wants a different contract, and silently
   * overriding it would make the flag a lie.
   */
  const originalSchemaPath = generatedSchema && !opts.schemaPath
    ? (() => {
        const p = join(runsDir, `${stamp}.schema.json`)
        writeFileSync(p, JSON.stringify(generatedSchema, null, 2))
        return p
    })()
    : opts.schemaPath
  const textReplyContract = !opts.schemaPath && generatedSchema === TEXT_REPLY_SCHEMA
  // Codex's --output-schema is OpenAI strict structured output. Its copy is
  // normalized beside the prompt; the caller's file remains byte-for-byte
  // untouched for Grok, whose --json-schema accepts ordinary JSON Schema.
  const schemaPath = name === 'codex' && originalSchemaPath
    ? (() => {
        const p = join(runsDir, `${stamp}.codex-schema.json`)
        writeFileSync(p, JSON.stringify(readStrictCodexSchema(originalSchemaPath), null, 2))
        return p
      })()
    : originalSchemaPath

  const started = Date.now()
  const head = originalPrompt.slice(0, 200).replace(/\s+/g, ' ')
  const inheritedLaunch = opts.resume
    ? db().query(
        `SELECT launch_cwd, launch_seed, launch_key, launch_base, no_failover
           FROM run WHERE id=?`,
      ).get(opts.resume.parent) as {
        launch_cwd: string | null; launch_seed: string | null; launch_key: string | null
        launch_base: string | null; no_failover: number
      }
    : null
  const launchCwd = inheritedLaunch?.launch_cwd ?? callerCwd
  const launchSeed = inheritedLaunch?.launch_seed ?? seed ?? null
  // A read-only run's key is an address on its record, not an input to the
  // worktree lifecycle. Writing runs retain the explicit-key-only behaviour
  // enforced by preflight and consumed below by createWithTool.
  const attributedKey = writesJob ? (opts.key ?? null) : (opts.key ?? inferredReadOnlyKey(callerCwd))
  const launchKey = inheritedLaunch?.launch_key ?? attributedKey
  const launchBase = inheritedLaunch?.launch_base ?? opts.base ?? null
  const noFailover = inheritedLaunch ? !!inheritedLaunch.no_failover : !!opts.noFailover
  // A repository row has no artifact address until creation returns one.
  const claimedCwd = repoJob ? null : callerCwd
  const claimedBranch = repoJob ? null : branchOf(callerCwd)
  // A reserved row is FILLED IN, not inserted: the id is already in the
  // caller's hands and printed, so allocating a second one here would hand back
  // an id that never finishes.
  const claim = opts.reserveId
    ? (db().query(
        // parent_run_id and turn are set HERE TOO, not only on the INSERT.
        //
        // A DETACHED resume claims its row through this path, and without these
        // two columns it came back as a fresh root: the chain silently forked,
        // `orch answer` on the original found the wrong latest turn, and the
        // roll-up wrote its outcome nowhere. The two claim paths must agree on
        // every column that means something, and these mean the most.
        `UPDATE run SET started_at=?, agent=?, job=?, repo=?, project_id=?, cwd=?, prompt_sha=?, spec_sha=?,
                        prompt_bytes=?, prompt_head=?, label=?, status='running', probe=?, retry_of=?,
                        route_reason=?, branch=?, parent_run_id=?, turn=?, vendor_session=?, docs_injected=?, doc_revisions=?, canon_sha=?,
                        launch_cwd=?, launch_seed=?, launch_key=?, launch_base=?, no_failover=?,
                        automatic_failover=?, review_ref=?, pid=?, mcp=?, transport=?
          WHERE id=? RETURNING id`,
      ).get(
        nowIso(), name, opts.job, runProjectName, runProjectId, claimedCwd, sha(prompt), sha(originalPrompt),
        Buffer.byteLength(prompt), head, opts.label ?? null, opts.probe ? 1 : 0, opts.retryOf ?? null, reason,
        claimedBranch,
        opts.resume?.parent ?? null, opts.resume ? opts.resume.turn : 1,
        // Known before spawn: minted (grok) or inherited on resume. A SIGKILL
        // or an exec.ts bootstrap failure never reaches the finally that used
        // to be the only write, and continue then refused a chain whose parent
        // already knew the id.
        vendorSession,
        pack?.docs.length ?? 0, pack ? JSON.stringify(pack.docs.map((doc) => doc.revisionId)) : null,
        pack?.sha256 ?? null,
        launchCwd, launchSeed, launchKey, launchBase, noFailover ? 1 : 0,
        opts.automaticFailover ? 1 : 0, opts.review ?? null, process.pid, storedMcpRequest(opts.mcp),
        transportName,
        opts.reserveId,
      ) as { id: number })
    : (db().query(
        `INSERT INTO run (started_at, agent, job, repo, project_id, cwd, prompt_sha, spec_sha, prompt_bytes, prompt_head, label, status, session_id, probe, retry_of, route_reason, branch, parent_run_id, turn, vendor_session, docs_injected, doc_revisions, canon_sha,
                          launch_cwd, launch_seed, launch_key, launch_base, no_failover,
                          automatic_failover, review_ref, pid, mcp, transport)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      ).get(
        nowIso(), name, opts.job, runProjectName, runProjectId, claimedCwd,
        sha(prompt), sha(originalPrompt), Buffer.byteLength(prompt), head, opts.label ?? null,
        // A resumed turn INHERITS the owning session rather than taking the
        // one that answered. The chain is one unit of work and one thing to
        // judge, and letting a second session adopt it by answering a question
        // would be the ownership rule leaking through a new door — the same
        // door `--detach` had to be stopped from opening.
        opts.resume ? opts.resume.sessionId : (opts.ownerSession ?? sessionId()),
        opts.probe ? 1 : 0, opts.retryOf ?? null, reason, claimedBranch,
        opts.resume?.parent ?? null, opts.resume ? opts.resume.turn : 1,
        vendorSession,
        pack?.docs.length ?? 0, pack ? JSON.stringify(pack.docs.map((doc) => doc.revisionId)) : null,
        pack?.sha256 ?? null,
        launchCwd, launchSeed, launchKey, launchBase, noFailover ? 1 : 0,
        opts.automaticFailover ? 1 : 0, opts.review ?? null, process.pid, storedMcpRequest(opts.mcp),
        transportName,
      ) as { id: number })

  /**
   * A child that asked has finished that turn once its successor exists.
   *
   * The root is deliberately excluded here: it carries the conversation's
   * rolled-up outcome and is routing evidence, while a child is independently
   * excluded from routing by `parent_run_id IS NULL`. `ok` records what
   * happened without fabricating a failure or an operator stop: the worker
   * fulfilled its contract by asking, the question was ruled on, and the
   * conversation moved to a later turn. The root's counterpart is
   * `resolveRootFromLastTurn`, which inherits the last turn's terminal status
   * once the chain has ended.
   *
   * Match the row's own facts even though continueRun already refuses an open
   * question. Keeping the answered-question and successor predicates here
   * makes this write incapable of retiring a genuinely waiting turn when
   * run() is called directly.
   */
  if (opts.resume) {
    resolveSupersededTurn(db(), opts.resume.parent, opts.resume.turn - 1)
  }
  const runToken = randomUUID()
  const inheritedKeepTree = opts.resume
    ? Boolean((db().query('SELECT keep_tree FROM run WHERE id=?').get(opts.resume.parent) as
        { keep_tree: number } | null)?.keep_tree)
    : false
  const keepTree = Boolean(opts.keepTree) || inheritedKeepTree
  db().query(
    `UPDATE run SET stack=?, model=?, run_token=?, mcp=?, mcp_server=?,
                    mcp_connected=?, mcp_error=?, schema_path=?, lens=?, keep_tree=? WHERE id=?`,
  )
    .run(
      stackAt(callerCwd), opts.model ?? a.model, runToken,
      storedMcpRequest(opts.mcp), mcpConnection?.server ?? null,
      mcpConnection?.connected == null ? null : mcpConnection.connected ? 1 : 0,
      mcpConnection?.error ?? (mcpMode ? 'no registered project identifies the canonical MCP server' : null),
      opts.schemaPath ?? null, opts.lens ?? null, keepTree ? 1 : 0, claim.id,
    )
  const scratchDir = runScratchDir(claim.id)
  mkdirSync(scratchDir, { recursive: true })
  writeDispatchState(claim.id, {
    deliverables: declaredDeliverables,
    timeoutMinutes: timeoutMinutes ?? null,
  })

  /**
   * A repository worker never runs in the caller's checkout.
   *
   * Cut AFTER the row exists, because the worktree is named by run id and the
   * id is what makes the mapping between a row and a directory total in both
   * directions. That ordering means a repository that cannot host a worktree
   * leaves a row behind — which is the right way round: the `finally` below
   * writes it terminal, so the failure is recorded rather than silent.
   */
  let worktree: Worktree | null = opts.resume?.worktree ?? null
  let carried: import('./worktree.ts').CarriedWorkingState | null = null
  let changes: import('./worktree.ts').Changes | null = null
  let isolatedCwd: string | null = null
  let provisionedMcpConfigLink: string | null = null
  let retargetDiagnostic: string | null = null
  let mcpSetupHeader: string | null = null
  let mcpTrustGranted = false
  /**
   * Cutting the worktree can FAIL, and the row already exists by now.
   *
   * A directory that is not a git repository, or a worktree path already taken,
   * throws here — and this used to happen outside the try/finally below, so the
   * row stayed `running` for ever with no process behind it until the stale
   * sweep guessed at it half an hour later. The rule three lines into this
   * function is that a run always writes its own terminal state; that has to
   * hold for the setup as much as for the agent.
   */
  let cwd = callerCwd
  try {
    const creating = repoJob && !worktree
    if (forbidsRepo) {
      // A self-contained job must not inherit the checkout it was launched
      // from. Read-only controls mutation, not visibility; the incident this
      // boundary closes was a reviewer reading the caller's HEAD and treating
      // it as part of an inline pack. An empty directory gives the process no
      // checkout at all, while launch_cwd retains project attribution.
      const isolateRoot = join(runsDir, 'isolates')
      mkdirSync(isolateRoot, { recursive: true, mode: 0o700 })
      chmodSync(isolateRoot, 0o700)
      isolatedCwd = noRepoIsolatePath(claim.id, runsDir)
      mkdirSync(isolatedCwd, { mode: 0o700 })
      cwd = isolatedCwd
      db().query('UPDATE run SET cwd=? WHERE id=?').run(cwd, claim.id)
    } else if (repoJob) {
      // A job that reads the repository must have a worktree, so a repository
      // it cannot be cut from is a hard failure.
      const tool = toolFor(callerCwd)
      if (creating) {
        const repoRoot = repoRootOf(callerCwd)
        if (!repoRoot) throw new Error(`not a git repository: ${callerCwd}`)
        const recordWorktree = (created: Worktree) => {
          const result = db().query(
            'UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=?, worktree_source=? WHERE id=?',
          ).run(
            created.path, created.path, reviewTarget?.branch ?? (created.branch || null),
            created.mintedBranch ?? null,
            coverageBase ?? created.base, created.source ?? null, claim.id,
          )
          if (result.changes !== 1) throw new Error(`run ${claim.id} could not record its worktree`)
        }
        worktree = withWorktreeCreateLock(repoRoot, () => {
          let created: Worktree
          if (!writesJob) {
            created = tool?.readonly_create
              ? createReadOnlyWithTool(tool, callerCwd, claim.id, readOnlyBase!, recordWorktree)
              : createReadOnlyWorktree(callerCwd, claim.id, readOnlyBase!, recordWorktree)
          } else if (tool) {
            // The PROJECT owns its worktrees. A bare `git worktree add` here would
            // produce a directory with no .env, no vendor and no database, in which
            // every test the worker runs is meaningless and green.
            created = createWithTool(
              tool, callerCwd, claim.id, seed, opts.key, reviewTarget?.commit ?? opts.base, recordWorktree,
              Boolean(reviewTarget),
            )
          } else {
            // INHERITED on a resume, and this is the point of the whole exercise:
            // the worker is mid-edit in that tree, and cutting a fresh one would
            // answer its question into an empty checkout and throw away everything
            // it had built.
            created = createWorktree(
              callerCwd, claim.id, reviewTarget?.commit ?? opts.base, recordWorktree,
              Boolean(reviewTarget),
            )
          }
          const current = db().query('SELECT status FROM run WHERE id=?').get(claim.id) as
            { status: string }
          if (current.status === 'stopped') {
            const cleanup = removeFor(created, created.repoRoot, false, false, claim.id)
            if (cleanup.removed) {
              db().query('UPDATE run SET worktree=NULL WHERE id=?').run(claim.id)
            }
            throw new Error(
              `run ${claim.id} was stopped during worktree creation; cleanup: ` +
              `${cleanup.removed ? 'removed' : cleanup.detail}`,
            )
          }
          try {
            // Carrying is opt-in, default off. That will look wrong: the
            // function exists so an architect iterating on unfinished work can
            // dispatch a run and have the worker see it. The asymmetry is what
            // decides it. Not carrying fails as a worker that lacks context and
            // says so — visible, recoverable, cheap. Carrying fails as another
            // author's half-finished work inside a diff that is then judged,
            // scored and possibly landed as the worker's — silent, and it
            // corrupts the evidence the whole system runs on. The case the
            // function exists for is still there: pass --carry.
            //
            // The ancestry guard is orthogonal: a behind-or-diverged caller is
            // refused whether or not carrying was requested.
            // An explicit review from trunk deliberately selects a branch that
            // need not descend from the caller. An overlay still comes only
            // from that branch's own checkout, where the ancestry guard remains
            // the protection against carrying reversions onto a newer tip.
            if ((!reviewTarget || opts.carry) && !namesRecordedRunTree({
              cwd: callerCwd, explicitCwd: opts.cwd !== undefined, base: opts.base, resume: opts.resume,
            })) {
              assertCallerAncestry(callerCwd, created)
            }
            carried = opts.carry
              ? carryWorkingState(callerCwd, created)
              : { base: created.base, tracked: [], untracked: [] }
          } catch (e) {
            const cleanup = removeFor(created, created.repoRoot, false, false, claim.id)
            throw new Error(
              `${String((e as Error)?.message ?? e)}\n` +
              `incomplete worktree cleanup: ${cleanup.removed ? 'removed' : cleanup.detail}`,
            )
          }
          return created
        })
      }
    }
    if (worktree) {
      const inheritedWorktree = worktree
      const recordWorktree = () => {
        if (opts.resume && !existsSync(inheritedWorktree.path)) {
          throw new Error(
            `resumed worktree ${inheritedWorktree.path} no longer exists after waiting for ` +
            `the project lifecycle lock`,
          )
        }
        if (!carried && opts.resume) {
          const inherited = db().query(
            `SELECT carry_base_commit, carry_tracked_paths, carry_untracked_paths
               FROM run WHERE id=?`,
          ).get(opts.resume.parent) as {
            carry_base_commit: string | null
            carry_tracked_paths: string | null
            carry_untracked_paths: string | null
          } | null
          if (inherited?.carry_base_commit && inherited.carry_tracked_paths !== null &&
              inherited.carry_untracked_paths !== null) {
            carried = {
              base: inherited.carry_base_commit,
              tracked: JSON.parse(inherited.carry_tracked_paths),
              untracked: JSON.parse(inherited.carry_untracked_paths),
            }
          }
        }
        db().query(
          `UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=?, worktree_source=?, carry_happened=?,
                          carry_base_commit=?, carry_tracked_paths=?, carry_untracked_paths=? WHERE id=?`,
        ).run(
          inheritedWorktree.path, inheritedWorktree.path,
          reviewTarget?.branch ?? (inheritedWorktree.branch || null),
          inheritedWorktree.mintedBranch ?? null,
          coverageBase ?? inheritedWorktree.base, inheritedWorktree.source ?? null,
          carried ? (carried.tracked.length + carried.untracked.length > 0 ? 1 : 0) : null,
          carried?.base ?? null,
          carried ? JSON.stringify(carried.tracked) : null,
          carried ? JSON.stringify(carried.untracked) : null,
          claim.id,
        )
      }
      if (opts.resume) {
        withWorktreeLease(
          inheritedWorktree.repoRoot, inheritedWorktree.path,
          { session: sessionId(), what: `resume ${claim.id}` },
          () => withWorktreeCreateLock(inheritedWorktree.repoRoot, recordWorktree),
        )
      } else {
        recordWorktree()
      }
      cwd = inheritedWorktree.path
      if (!opts.resume) {
        const caller = checkoutAliases(callerCwd)
        if (!caller) throw new Error(`could not resolve caller checkout root: ${callerCwd}`)
        retargetDiagnostic = caller.diagnostic
        // The project's worktree tool decides where the tree lives. Protect
        // that whole declared directory, obtained from the path it returned,
        // so a later turn cannot rebind an older sibling worktree beneath the
        // same root into the current destination.
        const declaredWorktreeRoot = dirname(worktree.path)
        let canonicalWorktreeRoot = declaredWorktreeRoot
        try { canonicalWorktreeRoot = realpathSync(declaredWorktreeRoot) } catch {
          /* the tool's spelling remains a valid protected address */
        }
        try {
          prompt = retargetRepositoryPromptForDispatch(
            prompt, caller.roots, worktree.path, caller.caseInsensitive,
            [...new Set([declaredWorktreeRoot, canonicalWorktreeRoot])],
          )
        } catch (error) {
          throw new Error([
            String((error as Error)?.message ?? error), caller.diagnostic,
          ].filter(Boolean).join('\n'))
        }
      }
      // The original file remains the caller's resumable spec. The bound file
      // and row describe what was actually sent after the worktree had an
      // address, which is the evidence an audit needs.
      writeFileSync(promptPath.replace(/\.prompt\.txt$/, '.bound.txt'), prompt)
      db().query('UPDATE run SET prompt_sha=?, prompt_bytes=? WHERE id=?')
        .run(sha(prompt), Buffer.byteLength(prompt), claim.id)
    }

    if (deferredCwdMcpPreflight) {
      const project = projectAt(callerCwd)
      if (!project) throw new Error(`no registered project identifies MCP configuration for ${callerCwd}`)
      const inheritedLink = opts.resume
        ? existingProvisionedMcpConfigLink(cwd, project.path)
        : null
      const config = provisionMcpConfig(cwd, project.path)
      mcpSetupHeader = config.header
      provisionedMcpConfigLink = config.header === null
        ? inheritedLink
        : readlinkSync(join(cwd, '.mcp.json'))
      const server = project.settings.mcpServer ?? project.name
      if (config.error) {
        mcpConnection = { server, connected: false, error: config.error }
      } else {
        const grokTrust = name === 'grok'
        const recorded = db().query(
          'SELECT id, cwd, worktree, worktree_source FROM run WHERE id=?',
        ).get(claim.id) as {
          id: number; cwd: string | null; worktree: string | null; worktree_source: string | null
        } | null
        if (grokTrust) assertGrokTrustEligible(cwd, recorded, runsDir)
        const beforeTrust = grokTrust ? grokTrustHeadings() : []
        mcpTrustGranted = grokTrust
        // Record the attempt before doctor: the trusted invocation may write its
        // store and then fail, and that remains a grant orch made.
        if (grokTrust) db().query('UPDATE run SET mcp_trust_granted=1 WHERE id=?').run(claim.id)
        try {
          mcpConnection = mcpConnectionFor(name, cwd, server, grokTrust, repoJob)
        } finally {
          if (grokTrust) {
            const added = addedGrokTrustHeadings(beforeTrust, grokTrustHeadings())
            db().query('UPDATE run SET mcp_trust_path=? WHERE id=?')
              .run(added.length ? JSON.stringify(added) : null, claim.id)
          }
        }
      }
      if (mcpTrustGranted && mcpConnection.connected === false &&
          /folder untrusted|repo-local server not started/i.test(mcpConnection.error ?? '')) {
        throw new Error(
          `Grok remained untrusted after scoped trust for ${cwd}: ${mcpConnection.error}`,
        )
      }
      const mismatched = wrongProjectReason(server, mcpConnection.namesSeen ?? [])
      if (mismatched) {
        mcpConnection = { ...mcpConnection, connected: false, error: mismatched }
      }
      if (mcpConnection.connected === false && mcpMode === 'prefer') {
        mcpConnection = {
          ...mcpConnection,
          error: mcpConnection.error?.startsWith('wrong project:')
            ? mcpConnection.error
            : `mirror: ${mcpConnection.error ?? `server '${server}' could not be attached`}`,
        }
        usingMcp = false
      }
      db().query(
        `UPDATE run SET mcp_server=?, mcp_connected=?, mcp_error=? WHERE id=?`,
      ).run(
        mcpConnection.server,
        mcpConnection.connected == null ? null : mcpConnection.connected ? 1 : 0,
        mcpConnection.error,
        claim.id,
      )
      const refusal = mcpAttachRefusal(mcpConnection)
      if (refusal && mcpMode === 'require') throw new Error(refusal)
    } else if (mcpConnection?.connected === false && mcpMode === 'prefer') {
      mcpConnection = {
        ...mcpConnection,
        error: `mirror: ${mcpConnection.error ?? `server '${mcpConnection.server}' could not be attached`}`,
      }
      usingMcp = false
      db().query('UPDATE run SET mcp_error=? WHERE id=?').run(mcpConnection.error, claim.id)
    }
  } catch (e) {
    if (isolatedCwd) rmSync(isolatedCwd, { recursive: true, force: true })
    const why = errorTail(String((e as Error)?.message ?? e))
    db().query(
      // 'harness': setting a worktree up is orch's job, and failing at it says
      // nothing whatever about the agent that was about to be given it.
      `UPDATE run SET
         status=CASE WHEN status='stopped' THEN status ELSE 'failed' END,
         error=CASE WHEN status='stopped' THEN error ELSE ? END,
         failure_kind=CASE WHEN status='stopped' THEN failure_kind ELSE 'harness' END,
         latency_ms=? WHERE id=?`,
    ).run(why, Date.now() - started, claim.id)
    teardownTerminalRunResources(db(), claim.id)
    throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), { runId: claim.id })
  }

  // Read-only Codex jobs keep scratch objects in this worktree's metadata and
  // read existing objects through a common-store alternate. Writing jobs use
  // the common store so commits survive removal of the disposable tree.
  const gitObjectEnvironment = gitObjectEnvironmentFor(name, requestedJob, worktree)
  const writableRoots = [
    scratchDir,
    ...(repoJob && worktree
      ? [worktreeGitDir(worktree.path),
          ...(writesJob ? workerSharedGitRoots(worktree.path, worktree.branch) : [])]
      : []),
  ]
  const gitConfigEnvironment = worktree
    ? prepareSharedRefGuard(
        worktree.path,
        writesJob && requestedJob.name !== 'land' ? `refs/heads/${worktree.branch}` : undefined,
      )
    : undefined
  if (gitConfigEnvironment && writableRoots) {
    assertSharedRefGuardOutsideWritableRoots(gitConfigEnvironment.GIT_CONFIG_VALUE_0, writableRoots)
  }
  const sandboxRoot = (db().query(
    'SELECT COALESCE(parent_run_id,id) AS id FROM run WHERE id=?',
  ).get(claim.id) as { id: number }).id
  const sandboxRunDir = join(runsDir, `sandbox-${sandboxRoot}`)
  const mcpConfig = readMcpConfig(cwd)
  const mcpServerName = mcpConnection?.server
    ?? projectAt(callerCwd)?.settings.mcpServer
    ?? projectAt(callerCwd)?.name
    ?? null
  const mcpEndpoint = mcpServerName ? resolveMcpServerUrl(mcpConfig[mcpServerName]) : null
  let sandboxSelection: ReturnType<typeof selectReadonlySandbox>
  try {
    sandboxSelection = selectReadonlySandbox({
      agent: name,
      readsRepo: repoJob,
      writesRepo: writesJob,
      worktree: worktree?.path ?? isolatedCwd,
      runsDir: sandboxRunDir,
      scratchDir,
      project: projectAt(callerCwd),
      readonlyNotes: toolFor(callerCwd)?.readonly_notes,
      override: process.env.ORCH_SANDBOX,
      path: process.env.PATH,
      localBaseUrl: LOCAL_BASE_URL,
      mcpEndpoint: mcpMode ? mcpEndpoint : null,
    })
  } catch (e) {
    const why = String((e as Error)?.message ?? e)
    db().query(
      `UPDATE run SET status='failed', error=?, failure_kind='harness', latency_ms=? WHERE id=?`,
    ).run(why, Date.now() - started, claim.id)
    teardownTerminalRunResources(db(), claim.id)
    throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), { runId: claim.id })
  }
  const srtSettingsPath = sandboxSelection.profile
    ? join(sandboxRunDir, 'settings.json')
    : null
  const sandboxEnvironment = sandboxSelection.profile
    ? prepareSandboxHome(name, sandboxRunDir)
    : {}
  const sandboxRouteReason = sandboxSelection.reason
    ? `${reason}; sandbox host: ${sandboxSelection.reason}`
    : reason
  db().query('UPDATE run SET sandbox=?, route_reason=? WHERE id=?')
    .run(sandboxSelection.sandbox, sandboxRouteReason, claim.id)
  if (sandboxSelection.reason) {
    const header = `sandbox host: ${sandboxSelection.reason}`
    mcpSetupHeader = mcpSetupHeader ? `${mcpSetupHeader}\n${header}` : header
    console.error(`orch: run ${claim.id} ${header}`)
  }

  if (mcpMode && mcpServerName) {
    const probeConfig = mcpConfig[mcpServerName]
    if (probeConfig?.url || probeConfig?.command) {
      try {
        const projectSettings = projectAt(callerCwd)?.settings as
          { mcp?: { probe_tool?: string } } | undefined
        const probeTool = projectSettings?.mcp?.probe_tool ?? null
        const wrap = sandboxSelection.profile && srtSettingsPath
          ? (bin: string, args: string[]) => srtLaunchArgv(
              sandboxSelection.profile!, srtSettingsPath, bin, args,
            )
          : undefined
        const probe = await probeMcpServer({
          server: mcpServerName,
          config: probeConfig,
          cwd,
          env: childEnv(a, claim.id, runToken, {
            ...(gitConfigEnvironment ?? {}), ...sandboxEnvironment,
          }, repoJob),
          probeTool,
          wrap,
        })
        // The probe runs only when the required server is in .mcp.json, so the
        // wrong-project question is already answered; the doctor path asks it.
        const recorded = probe
        const callEvidence = mcpCallEvidence(recorded)
        db().query(
          'UPDATE run SET mcp_probe=?, mcp_connected=?, mcp_error=? WHERE id=?',
        ).run(storedMcpProbe(recorded), callEvidence.connected, callEvidence.error, claim.id)
        if (callEvidence.connected !== 1 && mcpMode === 'require') {
          const why = callEvidence.connected === 0
            ? `MCP tool call failed on ${mcpServerName}: ${callEvidence.error}`
            : `mcp unverifiable on ${name}: ${callEvidence.error}` +
              `\ninvariant: --mcp means a proven tool call, never a handshake` +
              `\ncleared by: orch project set ${projectAt(callerCwd)?.name ?? '<project>'} --settings '{"mcp":{"probe_tool":"<a cheap read tool on ${mcpServerName}>"}}'`
          db().query(
            `UPDATE run SET status='failed', error=?, failure_kind='mcp_unverified', latency_ms=? WHERE id=?`,
          ).run(why, Date.now() - started, claim.id)
          teardownTerminalRunResources(db(), claim.id)
          throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), { runId: claim.id })
        }
        if (!recorded.ok) {
          mcpConnection = {
            server: mcpServerName, connected: false, error: recorded.error,
            namesSeen: recorded.namesSeen,
          }
          db().query(
            `UPDATE run SET mcp_connected=0, mcp_error=? WHERE id=?`,
          ).run(recorded.error, claim.id)
          usingMcp = false
        }
      } catch (error) {
        if ((error as { runId?: number }).runId === claim.id) throw error
        const why = String((error as Error)?.message ?? error)
        db().query(
          `UPDATE run SET status='failed', error=?, failure_kind='harness', latency_ms=? WHERE id=?`,
        ).run(why, Date.now() - started, claim.id)
        teardownTerminalRunResources(db(), claim.id)
        throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), { runId: claim.id })
      }
    } else {
      const namesSeen = namesSeenAt(cwd)
      const mismatched = wrongProjectReason(mcpServerName, namesSeen)
      if (mismatched) {
        const recorded: import('./mcp-probe.ts').McpProbeResult = {
          server: mcpServerName,
          tool: 'tools/list',
          ok: false,
          error: mismatched,
          durationMs: 0,
          detail: null,
          namesSeen,
        }
        mcpConnection = {
          server: mcpServerName, connected: false, error: mismatched, namesSeen,
        }
        db().query(
          'UPDATE run SET mcp_connected=0, mcp_error=?, mcp_probe=? WHERE id=?',
        ).run(mismatched, storedMcpProbe(recorded), claim.id)
        if (mcpMode === 'require') {
          const why = mcpAttachRefusal(mcpConnection)!
          db().query(
            `UPDATE run SET status='failed', error=?, failure_kind='harness', latency_ms=? WHERE id=?`,
          ).run(why, Date.now() - started, claim.id)
          teardownTerminalRunResources(db(), claim.id)
          throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), { runId: claim.id })
        }
        mcpConnection = { ...mcpConnection, error: `mirror: ${mismatched}` }
        usingMcp = false
        db().query('UPDATE run SET mcp_error=? WHERE id=?').run(mcpConnection.error, claim.id)
      }
    }
  }

  if (requiresCanonSource) {
    prompt += `\n\n${canonSourceInstruction(canonSourceFor(true, mcpConnection, repoJob))}`
    writeFileSync(promptPath.replace(/\.prompt\.txt$/, '.bound.txt'), prompt)
    db().query('UPDATE run SET prompt_sha=?, prompt_bytes=? WHERE id=?')
      .run(sha(prompt), Buffer.byteLength(prompt), claim.id)
  }

  bindSignals()

  // Declared out here because the `finally` has to be able to write a terminal
  // row whatever happened inside: the row is already claiming to be running, and
  // the one thing worse than a failed run is one that never says it stopped.
  // Only the handle the signal path and the finally need. Typing it as the full
  // Subprocess would widen stdout/stderr back to "pipe or fd or nothing", which
  // is what the narrowed `p` inside the try exists to avoid.
  let proc: { kill(sig?: number | string): void } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let killer: ReturnType<typeof setTimeout> | null = null
  let checkpointTimer: ReturnType<typeof setInterval> | null = null
  let idleTimer: ReturnType<typeof setInterval> | null = null
  let timedOut = false
  let idleKilled = false
  let idleKillError: string | null = null
  let idleUnkillable = false
  let exitCode = -1
  let output = ''
  let vendorTokens: number | null = null
  let costUsd: number | null = null
  let resolvedSession: string | null = vendorSession
  let effectiveModel: string | null = null
  let replyFileError: string | null = null
  let replyFilePresent = false
  let contract: WorkerReply | null = null
  let contractObjects = 0
  let acceptedQuestions: ReturnType<typeof realQuestions> = []
  let droppedQuestions: ReturnType<typeof realQuestions> = []
  let status = 'failed'
  let error: string | null = null
  let failureKind: ReturnType<typeof classify> | null = null
  let artifactsPersisted = true
  let preConfinement: string | null = null
  let vendorTerminatedStream: string | null = null
  let confinementFailures: FreezeFailure[] = []
  let confinementEvent: ConfinementEvent | null = null
  let frozenBefore: import('./confinement.ts').FrozenCheckout[] = []
  let askLoopback: AskLoopback | null = null
  // Start after orch's own worktree and hook setup, immediately before the
  // vendor process. The interval establishes when a change happened, not who
  // wrote it: an architect or concurrent landing can change a watched checkout.
  const callerProject = projectAt(callerCwd)
  const callerCheckout = callerProject
    ? gitContext(callerCwd, 'rev-parse', '--show-toplevel') ?? callerCwd
    : null
  const callerWatch = callerCheckout && callerCheckout !== isolatedCwd
    ? [{ project: callerProject!.name, path: callerCheckout }]
    : []
  const candidates = checkoutWatchSet(
    callerWatch, worktree?.path, opts.repo ?? callerProject?.name ?? null,
  )
  const beforeFreeze = freezeCheckouts(candidates.watched)
  const skipped = [...candidates.failures, ...beforeFreeze.failures]
  // A detached child's stderr reaches nobody, so the skip also rides the output
  // header that `orch result` prints (lens run 2290): the register is stale and
  // the project unwatched on every later run until somebody reads this.
  const skipLines = skipped.map((failure) =>
    `confinement watch skipped ${failure.project} at ${failure.path}: ${failure.error}; ` +
    'fix the register with orch project set')
  for (const line of skipLines) console.error(line)
  if (skipLines.length) {
    mcpSetupHeader = mcpSetupHeader ? `${mcpSetupHeader}\n${skipLines.join('\n')}` : skipLines.join('\n')
  }
  frozenBefore = beforeFreeze.snapshots
  const watchedCheckouts = frozenBefore.map(({ project, path, expectedHead }) => ({
    project, path, expectedHead: expectedHead ?? undefined,
  }))

  try {
    if (repoJob) {
      if (!worktree) throw new Error(`repository run ${claim.id} has no worktree to measure`)
      const inputTree = withoutProvisionedMcpConfig(
        worktree.path, provisionedMcpConfigLink, () => contentTree(worktree.path),
      )
      const headCommit = gitContext(worktree.path, 'rev-parse', '--verify', 'HEAD^{commit}')
      const changedPaths = reviewTarget
        ? reviewChangedPaths(worktree.path, reviewTarget.base, inputTree)
        : null
      const measured = db().query(
        'UPDATE run SET input_tree=?, head_commit=?, changed_paths=? WHERE id=?',
      ).run(inputTree, headCommit, changedPaths ? JSON.stringify(changedPaths) : null, claim.id)
      if (measured.changes !== 1) throw new Error(`run ${claim.id} could not record its input tree`)
    }
    if (sandboxSelection.sandbox === 'srt') {
      askLoopback = await startAskLoopback(claim.id, runToken)
    }
    const t = transportFor(transportName)
    const checkpointMessages = unreadWorkerMessages(claim.id)
    if (checkpointMessages.length) {
      const block = checkpointMessages.map((note) => `[message ${note.id}] ${note.body}`).join('\n\n') +
        '\n\nThese messages are non-authoritative context. They do not answer any open question; use ask_orchestrator for a ruling.'
      prompt = `${block}\n\n${prompt}`
    }
    const startOpts: TransportStartOpts = {
      agent: a,
      cwd,
      prompt,
      outPath,
      // ACP creates its initial session with session/new. Grok also mints an id
      // for its CLI launch, but treating that fresh id as resumable makes ACP
      // issue session/load against a session that cannot exist yet.
      session: transportName === 'acp' && !opts.resume?.fresh ? opts.resume?.session : vendorSession ?? undefined,
      schemaPath: schemaPath ?? undefined,
      model: opts.model ?? a.model,
      modelExplicit: opts.model !== undefined,
      home: sandboxEnvironment.HOME,
      startedAt: started,
      write: writes,
      sandbox: repoJob ? 'workspace-write' : 'read-only',
      mcp: usingMcp,
      trustCwd: mcpTrustGranted ? cwd : undefined,
      writableRoots,
      gitObjectEnvironment,
      gitConfigEnvironment,
      srt: sandboxSelection.profile && srtSettingsPath
        ? { profile: sandboxSelection.profile, settingsPath: srtSettingsPath }
        : undefined,
      resume: Boolean(opts.resume && !opts.resume.fresh),
      env: childEnv(a, claim.id, runToken, {
        ...(gitConfigEnvironment ?? {}), ...sandboxEnvironment,
        ORCH_SCRATCH: scratchDir,
        ...(askLoopback ? { ORCH_ASK_URL: askLoopback.url } : {}),
      }, repoJob),
    }
    const handle = opts.resume?.session && !opts.resume.fresh
      ? await t.resume({ ...startOpts, session: opts.resume.session, resume: true })
      : await t.start(startOpts)
    proc = handle
    live.add(handle)
    effectiveModel = handle.effectiveModel ?? null
    if (effectiveModel) db().query('UPDATE run SET model=? WHERE id=?').run(effectiveModel, claim.id)
    // The VENDOR CLI pid. pid stays the worker's for the whole run: after the
    // agent exits the worker is still parsing output and writing questions, and
    // a reaper that tested this pid would mark the run stale under a process
    // about to write its real outcome.
    //
    // Recorded HERE, before the wait, not after it. Written afterwards it is
    // always the pid of a process that has already exited.
    // Idle is silence of the VENDOR, not of orch's own setup. last_event_at
    // starts here so a slow worktree cut cannot burn the idle-kill budget.
    db().query(
      'UPDATE run SET agent_pid=?, last_event_at=COALESCE(last_event_at, ?) WHERE id=?',
    ).run(handle.pid, nowIso(), claim.id)

    const createCheckpoint = (final = false) => {
      if (!writesJob || !worktree || !launchKey) return null
      const result = checkpointRun({
        database: db(), runId: claim.id, worktree: worktree.path,
        branch: worktree.branch, taskKey: launchKey, scratchDir,
        guardEnvironment: gitConfigEnvironment ?? {}, final,
      })
      if (result.error) console.error(`orch: run ${claim.id} checkpoint failed: ${result.error}`)
      return result
    }
    if (writesJob) {
      checkpointTimer = setInterval(
        () => { createCheckpoint(false) },
        (requestedJob.checkpointMinutes ?? DEFAULT_CHECKPOINT_MINUTES) * 60_000,
      )
      if (worktree && launchKey) {
        liveCheckpoints.set(handle, {
          runId: claim.id, rootId: opts.resume?.parent ?? claim.id,
          worktree: worktree.path, branch: worktree.branch, taskKey: launchKey,
          scratchDir, guardEnvironment: gitConfigEnvironment ?? {},
        })
      }
    }

    // Two timeouts, composed, not one: the wall stays, and idle kill is the
    // second, shorter no-activity bound. Do not replace the wall.
    timer = setTimeout(() => {
      if (idleKilled) return
      timedOut = true
      void t.cancel(handle)
      // A CLI that ignores SIGTERM would otherwise keep the caller waiting for
      // ever, which is the thing the timeout exists to prevent.
      killer = setTimeout(() => { try { handle.kill(9) } catch { /* already gone */ } }, 5_000)
    }, boundMs)

    let forceCollect: ((result: TransportResult) => void) | null = null
    const forcedCollect = new Promise<TransportResult>((resolve) => {
      forceCollect = resolve
    })
    const maybeIdleKill = async () => {
      const row = db().query(
        'SELECT status, last_event_at, started_at FROM run WHERE id=?',
      ).get(claim.id) as { status: string; last_event_at: string | null; started_at: string } | null
      if (!row) return
      const openQuestion = db().query(
        'SELECT 1 n FROM question WHERE run_id=? AND answered_at IS NULL LIMIT 1',
      ).get(claim.id) as { n: number } | null
      const idleThresholdMs = jobIdleKillMs(opts.job)
      const decision = shouldIdleKill({
        lastEventAt: row.last_event_at, startedAt: row.started_at, pid: handle.pid,
        asking: row.status === 'asking', openQuestion: Boolean(openQuestion),
        alreadyTimedOut: timedOut, alreadyIdleKilled: idleKilled,
        thresholdMs: idleThresholdMs,
      })
      if (!decision.kill) return
      idleKilled = true
      const elapsed = Date.now() - started
      idleKillError = formatIdleKillError({
        idleMs: decision.idleMs ?? 0,
        reclaimedMs: Math.max(0, boundMs - elapsed),
        boundMs,
      })
      const checkpoint = createCheckpoint(true)
      if (checkpoint?.created || latestCheckpoint(db(), opts.resume?.parent ?? claim.id)) {
        db().query('UPDATE run SET work_preserved=1 WHERE id=?').run(claim.id)
      }
      void t.cancel(handle)
      const terminated = await terminateProcessGroup(handle.pid ?? 0)
      idleUnkillable = terminated.unkillable
      if (terminated.unkillable) {
        idleKillError = formatIdleKillError({
          idleMs: decision.idleMs ?? 0,
          reclaimedMs: Math.max(0, boundMs - elapsed),
          boundMs,
          unkillable: true,
          unkillableReason: terminated.reason,
        })
        forceCollect?.({
          stdout: '', stderr: idleKillError, raw: '', parsed: null, output: '',
          tokens: null, costUsd: null, sessionId: null, stopReason: 'timeout',
          error: idleKillError, exitCode: -1, pid: handle.pid ?? 0,
          events: [], asking: false, failureKind: 'idle', status: 'failed', questions: [],
        })
      }
    }
    let idleCheckInFlight = false
    idleTimer = setInterval(() => {
      if (idleCheckInFlight || timedOut || idleKilled) return
      idleCheckInFlight = true
      void maybeIdleKill().finally(() => { idleCheckInFlight = false })
    }, idlePollMs(jobIdleKillMs(opts.job)))

    const teeing = teeTransportEvents(handle.events(), claim.id)
    await t.prompt(handle, prompt)
    receiptWorkerMessages(claim.id, checkpointMessages.map((message) => message.id))
    const collected = await Promise.race([handle.collect(), forcedCollect])
    await teeing.catch(() => { /* the live log is observation, never outcome */ })
    const stdout = collected.stdout
    const stderr = collected.stderr
    // One derivation from the raw stream, carried through terminalisation.
    vendorTerminatedStream = [stdout, stderr].find(hasVendorTerminationMarker) ?? null
    exitCode = collected.exitCode
    const reply = collected.parsed
    const replyError = reply?.error ?? collected.error
    const outputCeilingReached = !!reply && !reply.text.trim() &&
      a.outputCeilingStopReason !== null && reply.stopReason === a.outputCeilingStopReason
    vendorTokens = collected.tokens
    costUsd = collected.costUsd
    effectiveModel = collected.effectiveModel ?? effectiveModel
    resolvedSession = collected.sessionId ?? vendorSession
    output = collected.output
    const replyFile = join(scratchDir, REPLY_FILE_NAME)
    if (existsSync(replyFile)) {
      replyFilePresent = true
      const fileOutput = readFileSync(replyFile, 'utf8')
      output = fileOutput
      const validationSchema = JSON.parse(readFileSync(originalSchemaPath!, 'utf8'))
      if (!presentReplyFileMatches({
        text: fileOutput,
        schema: validationSchema,
        customSchema: Boolean(opts.schemaPath),
        writesJob,
        issueWorker: requestedJob.name === 'issue-worker',
        findings: Boolean(requestedJob.findings),
        reader: isReaderJob(opts.job),
      })) {
        replyFileError = `${REPLY_FILE_NAME} did not match the worker contract:\n${fileOutput}`
      } else if (textReplyContract) {
        output = (JSON.parse(fileOutput) as { answer: string }).answer
      }
      writeFileSync(outPath, output)
    } else if (textReplyContract) {
      // The public result stays plain text. A conforming fallback final message
      // uses the file envelope, while legacy prose remains readable.
      try {
        const value = JSON.parse(output)
        if (valueMatchesStrictSchema(TEXT_REPLY_SCHEMA, value)) output = value.answer
      } catch { /* Missing-file fallback may be the legacy plain-text result. */ }
      writeFileSync(outPath, output)
    }
    if (!replyFilePresent && opts.schemaPath) {
      let value: unknown
      try { value = JSON.parse(output) } catch { value = null }
      const validationSchema = JSON.parse(readFileSync(originalSchemaPath!, 'utf8'))
      if (!valueMatchesStrictSchema(validationSchema, value)) {
        replyFileError = schemaMismatchError(output)
      }
    }
    const transportQuestions = collected.asking
      ? collected.questions.map((item) => ({
          question: item.question,
          options: item.options ?? null,
          recommendation: item.recommendation ?? null,
          why: item.why,
        }))
      : []
    for (const event of collected.events) {
      if (event.kind !== 'permission') continue
      const line = `permission ${event.decision}: ${event.title}` +
        (event.toolKind ? ` (${event.toolKind})` : '')
      mcpSetupHeader = mcpSetupHeader ? `${mcpSetupHeader}\n${line}` : line
    }

    /**
     * A worker that stopped to ask is neither a success nor a failure.
     *
     * Read BEFORE the success/failure ladder below, because every branch of it
     * would get this wrong: exit 0 with a reply looks like `ok`, and recording
     * a blocked run as `ok` would put an unfinished implementation into the
     * evidence base as a completed one — and would score an agent for work it
     * has not done. `blocked` is its own terminal state precisely so routing
     * can decline to count it either way.
     */
    /**
     * Parsed from whatever the agent WROTE, not only from a clean exit.
     *
     * codex writes its final message to the `-o` file as it finishes, so a
     * reply can be complete and valid while the process is killed a moment
     * later — by a harness command timeout, by SIGTERM travelling down a
     * process group. Gating the parse on `exitCode === 0` threw that reply away
     * and recorded "reply did not match the worker contract" over a reply that
     * matched it perfectly, which is a misleading epitaph for work that was
     * actually done.
     *
     * A parsed contract does not by itself make the run `ok` — the ladder below
     * still decides that — but it means the finished work is in hand and the
     * error can say what really happened.
     */
    const undelivered = unreadWorkerMessages(claim.id)
    if (undelivered.length) {
      const header = `undelivered worker messages: ${undelivered.map((message) => message.id).join(', ')}`
      mcpSetupHeader = mcpSetupHeader ? `${mcpSetupHeader}\n${header}` : header
    }
    if (writesJob && output) {
      const parsed = parseWorkerReplyWithCount(
        output, requestedJob.name === 'issue-worker' ? ISSUE_WORKER_SCHEMA : WORKER_SCHEMA,
      )
      contract = parsed.reply as WorkerReply | null
      contractObjects = parsed.contractObjects
    }
    const questionsControlStatus = isAsking(contract) || contract?.status === 'done'
    acceptedQuestions = questionsControlStatus ? realQuestions(contract) : transportQuestions
    const acceptedQuestionSet = new Set(acceptedQuestions)
    droppedQuestions = questionsControlStatus
      ? (contract?.questions ?? []).filter((item) => !acceptedQuestionSet.has(item))
      : []

    const completedReplyAtTimeout = contract?.status === 'done' ||
      (!writesJob && !replyError && !!output && !isNonAnswer(output))
    const acpVendorStop = transportName === 'acp' && collected.status === 'failed' &&
      Boolean(collected.stopReason && collected.stopReason !== 'end_turn')
    // Idle kill outranks the transport stop reason on every transport. ACP
    // cancel otherwise records stopReason timeout, which is routing evidence.
    if (idleKilled) {
      status = 'failed'
      error = errorTail(idleKillError ?? 'idle-killed with no CPU')
      failureKind = 'idle'
    } else if (acpVendorStop) {
      status = 'failed'
      error = errorTail(collected.error ?? stopErrorMessage(collected.stopReason!))
      failureKind = collected.failureKind ?? failureKindFromStop(collected.stopReason, collected.error)
    } else if (replyFileError) {
      status = 'failed'
      error = errorTail(replyFileError)
      failureKind = replyFilePresent ? 'contract' : 'other'
    } else if (collected.asking || acceptedQuestions.length) {
      status = 'asking'
      error = null
      failureKind = null
    } else if (outputCeilingReached) {
      status = 'failed'
      error = `response truncated at output ceiling (${reply!.stopReason})`
      failureKind = 'truncated'
    } else if (timedOut && completedReplyAtTimeout) {
      /**
       * IT FINISHED, AND THEN WE KILLED IT.
       *
       * A writing agent proves completion with its contract. A read-only
       * agent's answer IS its output, and completeness belongs to the later
       * delivery/quality judgement; requiring a writer-only contract here made
       * every read-only wall kill look like no answer even when substantial
       * work was already on disk.
       *
       * The writing case that first found this had completed fifteen files,
       * PHPStan and PHPUnit in Docker before our twenty-minute bound fired.
       * The read-only case produced a complete file-question answer before the
       * same kind of kill. Recording either as a timeout reads as "produced
       * nothing" and charges the agent for work it already delivered.
       *
       * The reply is on disk either way, so believe it. The kill is still
       * worth knowing about — the bound may be too short for this job — but it
       * is a note on a successful run, not a failure.
       */
      status = acceptedQuestions.length ? 'asking' : 'ok'
      error = null
      failureKind = null
      console.error(
        `orch: run ${claim.id} had already returned a complete reply when the ` +
        `${Math.round(boundMs / 60_000)}m bound killed it. Recorded ${status}; the bound may be short.`,
      )
    } else if (timedOut) {
      status = 'failed'
      error = `no reply within ${Math.round(boundMs / 60_000)}m; ${name} was killed`
      failureKind = 'timeout'
    } else if (replyError) {
      status = 'failed'
      error = errorTail(replyError)
      failureKind = classify(replyError, exitCode, timedOut, sandboxSelection.sandbox)
    } else if (exitCode === 0 && isNonAnswer(output)) {
      // Exit 0 and non-empty, but what came back is the vendor saying it
      // failed. Recorded as the failure it is rather than stored as an answer:
      // a run nobody can use should cost the agent the same as one that
      // crashed, not sit in the table looking like a success until a person
      // reads 57 bytes and works it out.
      status = 'failed'
      error = errorTail(output)
      failureKind = classify(output, exitCode, timedOut, sandboxSelection.sandbox)
    } else if (acceptedQuestions.length) {
      // `asking`, not `blocked`: the worker is doing exactly what it was told
      // to. The word matters because a `blocker` in this system is the
      // opposite — an environment problem — and on a page they read alike.
      status = 'asking'
      error = null
      failureKind = null
    } else if (isAsking(contract)) {
      /**
       * Asking without a real question is a CONTRACT FAILURE, not a pause.
       *
       * Run 1743 is the measured case: grok returned "placeholder" with no why
       * after 7.5 seconds, in orchestrator/runs/1788659791883-1743-grok-implement.txt.
       * The schema was satisfied, but no decision had been asked. Recording it
       * as asking created question 272 and summoned an architect to rule on
       * nothing. Preserve the rejected text in the error, create no question,
       * and let the ordinary failover policy hand untouched work to a new agent.
       */
      status = 'failed'
      const rejected = contract?.questions?.map((item) => JSON.stringify(item.question)).join(', ')
        || '(no question text)'
      error = errorTail(
        'the worker returned asking without a real question and non-empty why; ' +
        `rejected question text: ${rejected}`,
      )
      failureKind = 'contract'
    } else if (contract?.status === 'refused') {
      // The worker read the spec and says it cannot be built as written. That
      // is a real answer and often a correct one, so it is `ok` rather than a
      // failure: the agent did its job. Whether the refusal was RIGHT is a
      // quality judgement, which is the architect's to make and the score's to
      // record — not something to decide here from the word alone.
      status = exitCode === 0 ? 'ok' : 'failed'
      error = null
      failureKind = null
    } else if (exitCode !== 0 && contract?.status === 'done') {
      // The agent finished and wrote a complete reply, and THEN the process
      // died — a killed process group, most often. The work exists; saying so
      // is more honest than either 'ok' (it was interrupted) or a contract
      // complaint about a contract that was satisfied.
      status = 'failed'
      const terminal = stderr.trim() || stdout.trim()
      const terminalKind = classify(terminal, exitCode, timedOut, sandboxSelection.sandbox)
      failureKind = terminalKind
      error = errorTail(
        (FAILS_OVER.includes(terminalKind) ? `${terminal}\n` : '') +
        `the worker completed and wrote its reply, then the process ended ` +
        `(exit ${exitCode}). Its work is in the worktree; resume or read the diff.`,
      )
    } else if (writesJob && !contract) {
      // A writing run whose reply cannot be parsed has not reported what it
      // did, and its diff may be anything at all. Recording it `ok` would put
      // an unverifiable change set into the record as a completed one.
      status = 'failed'
      const terminal = stderr.trim() || output || stdout.trim()
      const terminalKind = classify(terminal, exitCode, timedOut, sandboxSelection.sandbox)
      if (FAILS_OVER.includes(terminalKind)) {
        error = errorTail(terminal)
        failureKind = terminalKind
      } else {
        error = errorTail(`reply did not match the worker contract:\n${output}`)
        failureKind = 'other'
      }
    } else {
      status = exitCode === 0 && output ? 'ok' : 'failed'
      error = status === 'failed'
        ? errorTail(stderr.trim() || stdout.trim() || `exit ${exitCode}, empty output`)
        : null
      failureKind = status === 'failed'
        ? classify(error, exitCode, timedOut, sandboxSelection.sandbox)
        : null
    }
  } catch (e) {
    // Spawn refused, a pipe broke, the output file could not be written. The row
    // exists and must not be left claiming to run.
    status = 'failed'
    error = errorTail(proc ? String((e as Error)?.stack ?? e) : String((e as Error)?.message ?? e))
    failureKind = proc ? 'other' : 'harness'
  } finally {
    if (timer) clearTimeout(timer)
    if (killer) clearTimeout(killer)
    if (checkpointTimer) clearInterval(checkpointTimer)
    if (idleTimer) clearInterval(idleTimer)
    if (proc) {
      live.delete(proc)
      liveCheckpoints.delete(proc)
    }
    if (askLoopback) await askLoopback.close()

    const recordedState = db().query('SELECT status FROM run WHERE id=?').get(claim.id) as
      { status: string } | null
    const preserveAtTerminal = writesJob && worktree && launchKey && (
      recordedState?.status === 'stopped' ||
      failureKind === 'timeout' || failureKind === 'idle' || failureKind === 'quota' || failureKind === 'context' || failureKind === 'cost'
    )
    if (preserveAtTerminal) {
      const checkpoint = checkpointRun({
        database: db(), runId: claim.id, worktree: worktree!.path,
        branch: worktree!.branch, taskKey: launchKey!, scratchDir,
        guardEnvironment: gitConfigEnvironment ?? {}, final: true,
      })
      if (checkpoint.created || latestCheckpoint(db(), opts.resume?.parent ?? claim.id)) {
        db().query('UPDATE run SET work_preserved=1 WHERE id=?').run(claim.id)
      }
      if (checkpoint.error) console.error(`orch: run ${claim.id} final checkpoint failed: ${checkpoint.error}`)
    }

    let frozenAfter: import('./confinement.ts').FrozenCheckout[] = []
    try {
      const afterFreeze = freezeCheckouts(watchedCheckouts)
      confinementFailures.push(...afterFreeze.failures.map((failure) => ({
        ...failure, error: `after snapshot: ${failure.error}`,
      })))
      frozenAfter = afterFreeze.snapshots
    } catch (e) {
      // A failure in the observation machinery itself cannot safely fabricate
      // which checkout was unreadable. Keep the original outcome and make the
      // harness fault visible; freeze failures take the binding path.
      console.error(`orch: could not freeze watched checkouts for run ${claim.id}: ${e}`)
    }

    // The directory contains no input and is useful only while the vendor is
    // alive. Remove it after readSession has had the chance to derive any
    // vendor-owned transcript location from cwd.
    if (isolatedCwd) rmSync(isolatedCwd, { recursive: true, force: true })

    /**
     * The diff is read EVEN WHEN THE RUN FAILED, and that is the point.
     *
     * A worker that timed out or crashed half way through an implementation has
     * left the most interesting artefact this system produces: a partial change
     * set showing exactly how far it got. Reading it only on success would
     * discard the evidence precisely where it is most useful, and would make a
     * timeout indistinguishable from a run that did nothing.
     *
     * Wrapped, because a diff that cannot be read must not turn a completed run
     * into a failed one — the agent's work is already done by this point, and
     * the row has to be written whatever git says.
     */
    if (worktree) {
      try {
        changes = withoutProvisionedMcpConfig(
          worktree.path, provisionedMcpConfigLink, () => changesIn(worktree),
        )
      } catch (e) {
        changes = null
        console.error(`orch: could not read the diff for run ${claim.id}: ${e}`)
      }
    }

    if (frozenBefore.length && frozenAfter.length && !confinementFailures.length) {
      const startedAt = (db().query('SELECT started_at, head_commit FROM run WHERE id=?').get(claim.id) as
        { started_at: string; head_commit: string | null } | null)
      confinementEvent = classifyDivergence({
        before: frozenBefore,
        after: frozenAfter,
        ownDiffPaths: changes?.files ?? [],
        chainRoot: startedAt?.head_commit ?? null,
        database: db(),
        startedAt: startedAt?.started_at ?? new Date(started).toISOString(),
      })
    }

    if (contract?.status === 'done' && contract.files_changed?.length === 0 &&
        contract.tests?.ran === false && changes?.files.length === 0 &&
        failureKind !== 'truncated') {
      status = 'failed'
      error = 'reported done with no change and no test run'
      failureKind = 'other'
    }
    if (retargetDiagnostic) error = error ? `${error}\n${retargetDiagnostic}` : retargetDiagnostic
    if (contractObjects > 1) {
      const note = `${contractObjects} contract objects in output; took the last`
      error = error ? `${error}\n${note}` : note
    }
    if (contract?.status === 'done' && acceptedQuestions.length) {
      const note = 'status reclassified from done to asking: a worker with a real question has not finished'
      error = error ? `${error}\n${note}` : note
    }
    if (droppedQuestions.length && (acceptedQuestions.length || contract?.status === 'done')) {
      const count = droppedQuestions.length
      const rejected = droppedQuestions.map((item) => JSON.stringify(item.question)).join(', ')
      const note = `${count} invalid question${count === 1 ? '' : 's'} dropped; ` +
        `rejected question text: ${rejected}`
      error = error ? `${error}\n${note}` : note
    }
    /**
     * A raw stdout/stderr stream ending in a vendor termination marker means the
     * vendor killed the session. Whatever else the run appears to be — an ACP stop
     * reason, a schema mismatch, a parsed question, a worker contract reporting
     * done — is an artefact of a stream that was cut off. Vendor truncation
     * therefore outranks every vendor-derived classification. It does NOT outrank
     * confinement (escaped, confinement_unverified), which outranks everything by
     * existing design.
     */
    if (vendorTerminatedStream) {
      status = 'failed'
      error = errorTail(vendorTerminatedStream)
      failureKind = 'truncated'
      acceptedQuestions = []
    }
    let parsedReview: ReturnType<typeof parseReviewOutput> = null
    if (requestedJob.findings && output && (status === 'ok' || confinementEvent)) {
      parsedReview = parseReviewOutput(output)
      if (!parsedReview && status === 'ok') {
        status = 'failed'
        error = 'reply did not match the review contract: mandatory PROVENANCE section missing or malformed'
        failureKind = 'contract'
      }
      if (parsedReview && status === 'ok' && confinementEvent?.classification !== 'overlapping') {
        const evidence = cleanReviewEvidence(claim.id, parsedReview)
        if (evidence.failure !== null) {
          status = 'failed'
          error = evidence.failure
          failureKind = evidence.kind
        } else if (evidence.note) {
          error = error ? `${error}\n${evidence.note}` : evidence.note
        }
      }
    }
    const ownProject = runProjectName ? projectByName(runProjectName) : undefined
    const ownMcpServer = mcpConnection?.server ??
      (ownProject ? ownProject.settings.mcpServer ?? ownProject.name : undefined)
    const otherProjectMcpServers = new Set(projects()
      .map((project) => project.settings.mcpServer ?? project.name)
      .filter((server) => server !== ownMcpServer && server !== 'orch' && server !== 'orch-ask'))
    const provenanceWrongProjectTool = parsedReview?.provenance.mcp_tools.find((tool) => {
      const claude = tool.match(/^mcp__(.+?)__/)
      const qualified = tool.match(/^([^.:/]+)[.:/]/)
      const server = claude?.[1] ?? qualified?.[1]
      return Boolean(server && otherProjectMcpServers.has(server))
    })
    if (parsedReview && provenanceWrongProjectTool && status === 'ok') {
      status = 'failed'
      error = `wrong project: provenance names ${provenanceWrongProjectTool}, expected ${ownMcpServer}`
      failureKind = 'contract'
    }
    if (status === 'ok' && isReaderJob(opts.job) && declaredDeliverables.length) {
      const reader = parseReaderOutput(output)
      const missing = missingDeclaredDeliverables(declaredDeliverables, reader)
      if (missing.length) {
        status = 'failed'
        error = `${UNEVIDENCED_DELIVERABLE_ERROR}: ${missing.join(', ')}`
        failureKind = 'unevidenced'
      }
    }

    /**
     * The questions are written in the SAME `finally` as the row, so a blocked
     * run cannot exist without them. Split across two statements, a crash in
     * between would leave a run marked `blocked` with nothing to answer — which
     * looks identical to a run waiting on a ruling nobody has given, and would
     * sit in the inbox for ever.
     */
    if (acceptedQuestions.length) {
      /**
       * A question asked through the LIVE channel and then repeated in the final
       * answer must not be recorded twice.
       *
       * That is the normal path when a live question times out: the tool tells
       * the worker to stop and report it, which is exactly what it then does.
       * Inserted again, the inbox shows the same question twice and `orch
       * answer` refuses a single ruling because it demands one per open
       * question — so the correct fallback made the run unanswerable.
       *
       * Matched on the question text, normalised, which is what the worker is
       * repeating verbatim from its own tool call.
       */
      const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase()
      const already = new Set(
        (db().query('SELECT question FROM question WHERE run_id = ?')
          .all(claim.id) as { question: string }[]).map((r) => norm(r.question)),
      )
      const q = db().query(
        `INSERT INTO question (run_id, asked_at, question, options, recommendation, why)
         VALUES (?,?,?,?,?,?)`,
      )
      for (const item of acceptedQuestions) {
        if (already.has(norm(item.question))) continue
        q.run(
          claim.id, nowIso(), item.question,
          item.options?.length ? JSON.stringify(item.options) : null,
          item.recommendation ?? null, item.why ?? null,
        )
        already.add(norm(item.question))
      }
    }

    if (mcpSetupHeader) {
      output = output ? `${mcpSetupHeader}\n\n${output}` : mcpSetupHeader
      writeFileSync(outPath, output)
    }

    // This post-process fact outranks every vendor exit or reply outcome. The
    // reply and diff remain stored, but an escaped write can never be an ok or
    // asking run and never inherits a failover-eligible vendor failure.
    if (confinementFailures.length) {
      preConfinement = JSON.stringify({ status, failureKind, error })
      status = 'failed'
      failureKind = 'confinement_unverified'
      error = confinementUnverifiedError(confinementFailures)
    } else if (confinementEvent?.classification === 'overlapping') {
      preConfinement = JSON.stringify({ status, failureKind, error })
      status = 'failed'
      failureKind = 'escaped'
      error = overlappingError(confinementEvent)
    }

    /**
     * BLOCKERS, from every job — not only the ones with a contract.
     *
     * The runs that reported these were review lenses, which carry no contract
     * at all, so a structured field alone would have caught none of them. What
     * they did was say it in prose and carry on, and nothing could count that.
     *
     * Declared and detected are stored side by side and kept distinguishable,
     * for the same reason measured and claimed facts are: one is the worker's
     * own account, the other is our reading of its prose, and a reader deserves
     * to know which they are looking at.
     */
    try {
      const rows: { what: string; why: string; impact: string | null; source: string; kind: string | null }[] = []
      for (const b of contract?.blockers ?? []) {
        /**
         * A DECLARED blocker gets a kind too, where we recognise one.
         *
         * `kind` is what makes recurrence countable, and a declared blocker had
         * none — so it grouped by its own prose, and two workers describing the
         * same denied socket in different words counted as two separate
         * problems. The detector already knows these shapes; run it over what
         * the worker wrote and use its answer when it finds one.
         *
         * Null when nothing matches, which is honest: an unrecognised blocker
         * is still worth recording, it just cannot be pooled with anything yet.
         */
        const [known] = detectBlockers(`${b.what}\n${b.why}`)
        rows.push({
          what: b.what, why: b.why, impact: b.impact ?? null,
          source: 'declared', kind: known?.kind ?? null,
        })
      }
      // Detected only where nothing was declared: a worker that filled the
      // field in has already told us, and adding our guess beside its answer
      // would double-count one blocker.
      if (!rows.length) {
        for (const d of detectBlockers(output)) {
          rows.push({ what: d.what, why: d.why, impact: null, source: 'detected', kind: d.kind })
        }
      }
      if (rows.length) {
        const q = db().query(
          `INSERT INTO blocker (run_id, at, what, why, impact, source, kind)
           VALUES (?,?,?,?,?,?,?)`,
        )
        for (const r of rows) q.run(claim.id, nowIso(), r.what, r.why, r.impact, r.source, r.kind)
      }
    } catch (e) {
      // Never let recording a blocker fail a run that otherwise succeeded.
      console.error(`orch: could not record blockers for run ${claim.id}: ${e}`)
    }

    const terminalSnapshot: TerminalSnapshot = {
      status, error, failureKind, output, outputPath: outPath, promptPath,
      exitCode, latencyMs: Date.now() - started,
      vendorTokens, vendorCostUsd: costUsd, model: effectiveModel,
      vendorSession: resolvedSession, preConfinement,
      confinement: confinementEvent ? JSON.stringify(confinementEvent) : null,
      filesChanged: writesJob ? changes?.files.length ?? null : null,
      changedPaths: writesJob && changes ? JSON.stringify(changes.files) : null,
      linesAdded: writesJob ? changes?.insertions ?? null : null,
      linesRemoved: writesJob ? changes?.deletions ?? null : null,
      testsRan: writesJob ? (contract?.tests ? (contract.tests.ran ? 1 : 0) : null) : null,
      testsPassed: writesJob
        ? (contract?.tests?.passed === undefined ? null : contract.tests.passed ? 1 : 0)
        : null,
      deviations: writesJob ? contract?.deviations?.length ?? null : null,
      escalations: writesJob ? acceptedQuestions.length : null,
    }
    persistTerminalSnapshot(claim.id, terminalSnapshot)
    const reviewProvenance = parsedReview ? JSON.stringify(parsedReview.provenance) : null
    const provenanceSilent = parsedReview && parsedReview.provenance.could_not_verify.length === 0 && (
      parsedReview.provenance.substitutes.length > 0 ||
      (mcpMode !== null && mcpConnection?.connected !== true) ||
      Boolean(provenanceWrongProjectTool)
    )
    const writeTerminalRow = () => writeTransaction(() => {
      db().query(
        `UPDATE run SET latency_ms=?, exit_code=?, output_bytes=?, output_path=?, prompt_path=?,
                        vendor_tokens=?, vendor_cost_usd=?, model=COALESCE(?, model),
                        status=CASE WHEN status='stopped' THEN status ELSE ? END,
                        error=CASE WHEN status='stopped' THEN error ELSE ? END,
                        failure_kind=CASE WHEN status='stopped' THEN failure_kind ELSE ? END,
                        vendor_session=COALESCE(?, vendor_session), pre_confinement=?, confinement=?,
                        review_provenance=?, provenance_status=?,
                        unreconciled=0 WHERE id=?`,
      ).run(
        Date.now() - started, exitCode, new TextEncoder().encode(output).byteLength, outPath, promptPath,
        vendorTokens, costUsd, effectiveModel, status, error, failureKind,
        resolvedSession, preConfinement,
        confinementEvent ? JSON.stringify(confinementEvent) : null,
        reviewProvenance, provenanceSilent ? 'silent' : null, claim.id,
      )

      /**
       * The facts, recorded without anyone's opinion.
       *
       * Half of them are MEASURED (what the diff actually contains) and half are
       * CLAIMED (what the worker says about its own tests and deviations), and
       * they are stored side by side deliberately: the interesting signal is
       * where the two disagree. A worker reporting `tests.passed` beside a diff
       * that touches no test file has told you something, and no verdict is
       * needed to see it.
       */
      if (writesJob) {
        db().query(
          `UPDATE run SET files_changed=?, changed_paths=?, lines_added=?, lines_removed=?,
                          tests_ran=?, tests_passed=?, deviations=?, escalations=? WHERE id=?`,
        ).run(
          changes?.files.length ?? null,
          changes ? JSON.stringify(changes.files) : null,
          changes?.insertions ?? null,
          changes?.deletions ?? null,
          contract?.tests ? (contract.tests.ran ? 1 : 0) : null,
          contract?.tests?.passed === undefined ? null : contract.tests.passed ? 1 : 0,
          contract?.deviations?.length ?? null,
          acceptedQuestions.length,
          claim.id,
        )
      }

      /**
       * THE ROOT CARRIES THE CHAIN'S OUTCOME. This is the line that makes a
       * multi-turn conversation one unit of work rather than three.
       *
       * Without it the arithmetic goes wrong in both directions at once. A chain
       * that ends well is root=`blocked` plus child=`ok`, so nothing is ever
       * offered for scoring — the root is not `ok` and the child is excluded from
       * evidence — and an implementation that succeeded would teach the router
       * nothing. Meanwhile the blocked root would sit in the inbox for ever,
       * still looking like a question nobody answered.
       *
       * The child terminal write and this roll-up share one transaction, so the
       * root can only inherit the terminal state written immediately above.
       * Every existing query therefore keeps working untouched: one row per unit
       * of work, holding where that work has got to, with the children recording
       * what each turn cost.
       */
      if (opts.resume) {
        // A resumed turn that stopped to ask reopens the conversation: the root
        // goes back to asking with no failure kind, because the chain has not
        // ended. The resolver below only writes terminal outcomes, so an asking
        // turn must be rolled here or an ok/failed root would keep looking
        // finished while a question waits (lens run 2277).
        if (status === 'asking') {
          db().query(
            `UPDATE run SET status='asking', error=?, failure_kind=NULL
              WHERE id=? AND parent_run_id IS NULL AND status NOT IN ('stopped', 'stale')`,
          ).run(error, opts.resume.parent)
        }
        resolveRootFromLastTurn(db(), opts.resume.parent)
      }

      // A parsed findings reply is the review event. Capture it in the same
      // terminal transaction so a successful lens cannot exist in the gap
      // between "ran" and "recorded". Manual `orch review record` remains the
      // recovery path for historical or otherwise uncaptured outputs.
      if (parsedReview && (status === 'ok' || failureKind === 'escaped')) {
        recordReview(opts.resume?.parent ?? claim.id, parsedReview)
      }
    })
    try {
      writeTerminalRow()
    } catch (terminalError) {
      const detail = terminalError instanceof Error ? terminalError.message : String(terminalError)
      try {
        writeTerminalRow()
      } catch (retryError) {
        const retry = retryError instanceof Error ? retryError.message : String(retryError)
        try {
          db().query(
            `UPDATE run SET unreconciled=1, error=? WHERE id=? AND status IN ('running','asking')`,
          ).run(
            `unreconciled: reply at ${runTerminalReplyPath(claim.id)}; ` +
            `cleared by: orch reconcile ${claim.id}  (${retry})`,
            claim.id,
          )
        } catch { /* the snapshot is on disk; the row write is what failed */ }
        console.error(`orch: run ${claim.id} left unreconciled: ${detail}`)
      }
    }
    const recorded = db().query(
      'SELECT status, failure_kind FROM run WHERE id=?',
    ).get(claim.id) as { status: string; failure_kind: string | null } | null
    if (!recorded) {
      throw new Error(`run ${claim.id} disappeared before terminalisation`)
    }
    teardownTerminalRunResources(db(), claim.id)
    if (recorded.failure_kind === 'quota' || recorded.failure_kind === 'timeout') {
      tryWriteContention({
        resourceKind: 'vendor', resourceKey: name,
        eventKind: recorded.failure_kind === 'quota' ? 'refusal' : 'timeout',
        durationMs: Date.now() - started, cause: error, runId: claim.id,
      })
    } else if (recorded?.failure_kind === 'escaped' || recorded?.failure_kind === 'confinement_unverified') {
      const event = confinementEvent
      tryWriteContention({
        resourceKind: 'main_checkout',
        resourceKey: event?.checkout ?? confinementFailures[0]?.path ?? callerCwd,
        eventKind: 'invalidation',
        cause: error, runId: claim.id,
      })
    }

    try {
      persistRunArtifacts(
        claim.id,
        isReaderJob(opts.job) ? parseReaderOutput(output)?.files_written ?? null : null,
        worktree,
        changes,
      )
    } catch (e) {
      artifactsPersisted = false
      status = 'failed'
      failureKind = 'harness'
      error = `artifact persistence failed for ${runArtifactsDir(claim.id)}: ${String((e as Error)?.message ?? e)}`
      db().query(
        `UPDATE run SET
           status=CASE WHEN status='stopped' THEN status ELSE 'failed' END,
           error=CASE WHEN status='stopped' THEN error ELSE ? END,
           failure_kind=CASE WHEN status='stopped' THEN failure_kind ELSE 'harness' END
         WHERE id=?`,
      )
        .run(error, claim.id)
      if (opts.resume) resolveRootFromLastTurn(db(), opts.resume.parent)
      teardownTerminalRunResources(db(), claim.id)
      console.error(`orch: ${error}`)
    }
  }

  // Quota and auth stop this agent working until a person acts. Notify at the
  // moment it happens even though the failover path below can route around it.
  if (failureKind && NEEDS_HUMAN.includes(failureKind)) {
    notify(
      NEEDS_HUMAN_TITLE[failureKind]?.(name) ?? `${name} needs attention`,
      `${opts.job} failed. Routing will avoid it until it succeeds again.`,
    )
  }
  if (idleUnkillable) {
    notify(
      `${name} idle kill did not terminate`,
      `run ${claim.id} still alive after SIGKILL; needs a human`,
    )
  }

  if (status === 'failed' && failureKind && FAILS_OVER.includes(failureKind)) {
    // The vendor is normally gone already. This is deliberately the same PID
    // termination primitive used by `orch stop`, excluding this coordinator:
    // it still has to route and run the successor before it may exit.
    terminateRunProcesses(claim.id, [process.pid])

    const attempts = failoverAttempts(claim.id)
    const tried = attempts.map((attempt) => attempt.agent)
    const first = db().query(
      `SELECT prompt_path, launch_cwd, launch_seed, launch_key, launch_base,
              no_failover, session_id, mcp, mcp_error, schema_path, probe, label, lens, repo,
              base_commit, head_commit, review_ref, transport
         FROM run WHERE id=?`,
    ).get(attempts[0]!.id) as {
      prompt_path: string | null; launch_cwd: string | null; launch_seed: string | null
      launch_key: string | null; launch_base: string | null; no_failover: number
      session_id: string | null; mcp: number | null; mcp_error: string | null; schema_path: string | null
      probe: number; label: string | null; lens: string | null; repo: string | null
      base_commit: string | null; head_commit: string | null; review_ref: string | null
      transport: TransportName | null
    }
    const treeName = worktree?.path ?? '(none — read-only job)'
    if (first.no_failover || opts.noFailover) {
      appendFailoverRefusal(claim.id, `disabled by --no-failover; worktree ${treeName}`)
    } else if (writingFailoverRefusal(writesJob, changes, treeName)) {
      appendFailoverRefusal(claim.id, writingFailoverRefusal(writesJob, changes, treeName)!)
    } else if (attempts.length >= MAX_FAILOVER_ATTEMPTS) {
      appendFailoverRefusal(
        claim.id,
        `the ${MAX_FAILOVER_ATTEMPTS}-attempt budget was spent; tried ${tried.join(', ')}; worktree ${treeName}`,
      )
    } else if (!first.prompt_path || !existsSync(first.prompt_path)) {
      appendFailoverRefusal(
        claim.id,
        `the original prompt is no longer on disk; tried ${tried.join(', ')}; worktree ${treeName}`,
      )
    } else {
      try {
        const originalPrompt = readFileSync(first.prompt_path, 'utf8')
        const next = pick(
          opts.job, undefined,
          Buffer.byteLength(originalPrompt) + (requestedJob.findings ? CALIBRATION_SUFFIX_RESERVE_BYTES : 0), true,
          stackAt(first.launch_cwd ?? callerCwd),
          { agents: [...new Set([...(opts.avoid ?? []), ...tried])] },
          false,
          first.lens ?? undefined,
        )
        console.error(
          `orch: run ${claim.id} failed over after ${name} ${failureKind}; ` +
          `starting the same prompt on ${next.agent}`,
        )
        // The recursive successor has its own terminalisation path. Reclaim
        // this completed attempt before returning into it, otherwise this
        // frame never reaches the ordinary terminal reclaim below.
        if (artifactsPersisted && worktree && reclaimsTreeByDefault(opts.job) && !keepTree) {
          reclaimTerminalTree(claim.id, worktree)
        }
        return await run({
          job: opts.job,
          prompt: originalPrompt,
          agent: next.agent,
          transport: first.transport === 'cli' || first.transport === 'acp'
            ? first.transport : undefined,
          schemaPath: first.schema_path ?? undefined,
          mcp: mcpRequestFromStored(first.mcp, first.mcp_error),
          probe: !!first.probe,
          label: first.label ?? undefined,
          lens: first.lens ?? undefined,
          cwd: first.launch_cwd ?? callerCwd,
          repo: first.repo ?? undefined,
          retryOf: claim.id,
          noFailover: false,
          ownerSession: first.session_id,
          automaticFailover: true,
          seed: first.launch_seed ?? undefined,
          key: first.launch_key ?? undefined,
          // Every repository successor must recreate the first attempt's
          // immutable tree before carrying the same caller state. Falling back
          // to current trunk makes a review failover depend on a later move.
          base: repoJob ? (first.base_commit ?? first.launch_base ?? undefined) : undefined,
          avoid: opts.avoid,
          carry: opts.carry,
          review: first.review_ref ?? undefined,
          deliverables: declaredDeliverables,
          timeoutMinutes,
          keepTree,
          resolvedReviewTarget: first.review_ref && first.base_commit && first.head_commit
            ? {
                branch: resolveLandingBranch(first.review_ref).branch,
                commit: first.head_commit,
                base: first.base_commit,
              }
            : undefined,
        })
      } catch (e) {
        const successor = db().query('SELECT id FROM run WHERE retry_of=?').get(claim.id)
        // Once a successor exists its own terminal row is the explanation.
        if (successor) throw e
        appendFailoverRefusal(
          claim.id,
          `no eligible agent remains after trying ${tried.join(', ')}: ` +
          `${String((e as Error)?.message ?? e)}; worktree ${treeName}`,
        )
      }
    }
  }

  if (artifactsPersisted && worktree && reclaimsTreeByDefault(opts.job) && !keepTree &&
      status !== 'asking' && status !== 'running') {
    reclaimTerminalTree(claim.id, worktree)
  }

  if (status === 'failed') {
    throw Object.assign(new Error(`run ${claim.id} failed: ${error}`), { runId: claim.id })
  }
  return {
    id: claim.id, agent: name, reason, output, latencyMs: Date.now() - started, exitCode,
    vendorTokens, costUsd, outPath, worktree, changes, contract, status,
  }
}
