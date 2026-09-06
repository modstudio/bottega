import {
  mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync, rmSync,
  realpathSync, statSync, unlinkSync, symlinkSync, readlinkSync, lstatSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import {
  classify, notify, isNonAnswer, detectBlockers, NEEDS_HUMAN, NEEDS_HUMAN_TITLE,
  FAILS_OVER,
} from './failure.ts'
import {
  AGENTS, ensureLocalHealth, tryWake, readStrictCodexSchema, minimumCliVersionRefusal,
  LOCAL_BASE_URL,
  type SandboxLevel,
} from './agents.ts'
import { job, type Job } from './jobs.ts'
import { pick } from './route.ts'
import {
  db, nowIso, DB_PATH, sessionId, resolveRootFromLastTurn, writableDb, writeTransaction,
} from './db.ts'
import {
  createWorktree, createWithTool, createReadOnlyWorktree, createReadOnlyWithTool,
  toolFor, changesIn, repoRootOf, resolveBase, resolveReadOnlyBase, worktreeGitDir,
  createCommandExists,
  prepareWorktreeObjects, prepareSharedRefGuard, carryWorkingState,
  assertSharedRefGuardOutsideWritableRoots,
  targetGitEnvironment,
  workerSharedGitRoots,
  contentTree,
  assertCallerAncestry, withWorktreeCreateLock, withWorktreeLease,
  removeFor, type Worktree,
  type WorktreeObjectEnvironment, validateSeedWithTool,
} from './worktree.ts'
import { recipeNotes } from './recipe.ts'
import {
  workerPreamble, packResumePrompt, READONLY_PREAMBLE, NO_REPO_PREAMBLE, WORKER_SCHEMA, ISSUE_WORKER_SCHEMA, REVIEW_SCHEMA,
  REVIEW_SEVERITY_INSTRUCTION,
  VERIFY_CLAIM_SCHEMA,
  parseWorkerReplyWithCount, isAsking, realQuestions,
  type CanonSource, type WorkerReply,
} from './contract.ts'
import {
  CALIBRATION_SUFFIX_RESERVE_BYTES, calibrationLine, cleanReviewEvidence,
  parseReviewOutput, reviewCalibration,
} from './review.ts'
import { createHasPlaceholder, projectAt, projects, stackAt,
         validateProjectSettings } from './projects.ts'
import { compilePack, recordPack } from './canon.ts'
import { seedGuidance } from './args.ts'
import { resolveRunsDirectory } from './database-location.ts'
import { resolveLandingBranch } from './landing.ts'
import { TRUNCATED_TRANSCRIPT_BYTES } from './result-output.ts'
import { addedGrokTrustHeadings, grokTrustHeadings } from './grok-trust.ts'
import { prepareSandboxHome, selectReadonlySandbox, SRT_BIN } from './sandbox.ts'

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
  /** Carry the caller's uncommitted work into a newly cut worktree. Opt-in. */
  carry?: boolean
  /** Branch or run id whose recorded branch a findings job reviews. */
  review?: string
  /** Preserve the session that owns a successor root. */
  ownerSession?: string | null
  /** Resume only: everything needed to continue a worker where it stopped. */
  resume?: {
    parent: number; agent: string; session: string; turn: number
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

/** Translate the detached wire format into the names run() consumes. */
export function detachedRunOptions(
  jobName: string, prompt: string, reserveId: number, spec: DetachSpec,
) {
  const {
    agent, schema, mcp, model, probe, label, lens, seed, key, repo, base, avoid,
    distinctModels, retryOf, cwd, noFailover, carry, review, ownerSession, resume,
  } = spec
  // Adding a field to DetachSpec must fail typechecking until it is handled here.
  const consumed: Required<Record<keyof DetachSpec, unknown>> = {
    agent, schema, mcp, model, probe, label, lens, seed, key, repo, base, avoid,
    distinctModels, retryOf, cwd, noFailover, carry, review, ownerSession, resume,
  }
  void consumed
  return {
    job: jobName, prompt, reserveId,
    agent, schemaPath: schema, mcp, model, probe, label, lens, seed, key, repo, base, avoid,
    distinctModels, retryOf, cwd, noFailover, carry, review, ownerSession, resume,
  }
}

const EXPLICIT_REVIEW_JOBS = new Set(['review-lens', 'safety', 'craft'])

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
  const trunkCommit = resolveBase(cwd, `${trunk}^{commit}`)
  const base = gitContext(cwd, 'merge-base', commit, trunkCommit)
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
    if (found) {
      const error = (found.checks ?? [])
        .filter((check) => check.passed === false)
        .map((check) => [check.label, check.detail, check.hint].filter(Boolean).join(': '))
        .join('; ')
      return { server, connected: found.healthy === true, error: error || null }
    }
    const available = (report.servers ?? [])
      .map((candidate) => candidate.name)
      .filter((name): name is string => Boolean(name))
    const listed = available.length ? available.join(', ') : '(none)'
    return {
      server,
      connected: false,
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
function mcpConnectionFor(name: string, cwd: string, server: string, trust = false): McpConnection {
  if (name === 'grok') {
    const grok = AGENTS.grok!
    return grokMcpConnection(grok.bin, cwd, server, childEnv(grok), trust)
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
  recorded: { worktree: string | null; worktree_source: string | null } | null,
): void {
  const orchCut = recorded?.worktree === cwd &&
    ['recipe', 'git', 'readonly_recipe'].includes(recorded.worktree_source ?? '')
  if (orchCut) return
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
 * we can prove failed. Cwd-discovered repository MCP is deferred until the
 * worker tree exists, but the vendor process still never starts on refusal.
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
  const { agent: name } = pick(
    opts.job, opts.agent, opts.prompt.length, true, stackAt(opts.cwd),
    { agents: opts.avoid, models: opts.distinctModels, model: opts.model },
    opts.probe,
    opts.lens,
  )
  const selected = AGENTS[name]!
  if (selected.caps.discoversMcpFromCwd && job(opts.job).needs.readsRepo) {
    return
  }
  const connection = probeRequestedMcp(mode, name, opts.cwd)
  if (!connection) return
  const why = mcpAttachRefusal(connection)
  if (why && mode === 'require') throw new Error(why)
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
): string | undefined {
  if (depth() >= MAX_DEPTH) {
    throw new Error(
      `refusing to delegate at depth ${depth()}: this process is itself a delegated agent. ` +
        'Answer the question with the tools you have, or hand it back to the caller.',
    )
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
  const tool = project?.settings.worktree ?? null
  if (project && tool?.create && typeof tool.create !== 'string') {
    const malformed = validateProjectSettings(project.settings)
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
  if (writesJob && baseRef && tool?.create && !createHasPlaceholder(tool.create, 'base')) {
    problems.push(
      `project ${project!.name} cannot honour --base because its worktree create template ` +
      `${JSON.stringify(tool.create)} has no {base} slot`,
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

function realpathOrSpelled(path: string): string {
  try { return realpathSync(path) } catch { return path }
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
  extra: Record<string, string> = {},
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
  env.ORCH_DB = DB_PATH
  return { ...env, ...(a.env?.() ?? {}), ...extra }
}

/**
 * Children alive right now, so a signal can take them down with us.
 *
 * Without this, SIGTERM to `orch do` leaves the agent reparented to init with
 * nobody left to record what it did: the row claims to be running for ever, and
 * a subscription keeps being spent on an answer no one will read.
 */
const live = new Set<{ kill(sig?: number | string): void }>()

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

function bindSignals() {
  if (signalsBound) return
  signalsBound = true
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      for (const p of live) { try { p.kill('SIGTERM') } catch { /* already gone */ } }
      // The `finally` in run() writes the terminal row; give it the turn it
      // needs before the process goes away.
      setTimeout(() => process.exit(130), 250)
    })
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** Codex reports "tokens used\n<n>" on stderr; other agents report nothing. */
function parseVendorTokens(blob: string): number | null {
  const m = blob.match(/tokens used\s*\n?\s*([\d,]+)/i)
  return m ? Number(m[1]!.replace(/,/g, '')) : null
}

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
}

export type OutsideWorktreeWrite = {
  project: string
  path: string
  before: string
  after: string
}

type CheckoutToWatch = { project: string; path: string }

type CheckoutSampleFailure = CheckoutToWatch & { error: string }

type CheckoutSample = {
  snapshots: CheckoutStatusSnapshot[]
  failures: CheckoutSampleFailure[]
}

type CheckoutCandidates = {
  watched: CheckoutToWatch[]
  failures: CheckoutSampleFailure[]
}

function checkoutWatchSet(
  additional: CheckoutToWatch[] = [], activeWorktree?: string,
): CheckoutCandidates {
  const active = activeWorktree ? realpathSync(activeWorktree) : null
  const watched: CheckoutToWatch[] = []
  const failures: CheckoutSampleFailure[] = []
  const seen = new Set<string>()
  for (const checkout of [
    ...projects().map(({ name, path }) => ({ project: name, path })),
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
    watched.push({ project: checkout.project, path: canonical })
  }
  return { watched, failures }
}

function sampleCheckouts(watched: CheckoutToWatch[]): CheckoutSample {
  const snapshots: CheckoutStatusSnapshot[] = []
  const failures: CheckoutSampleFailure[] = []
  for (const checkout of watched) {
    try {
      const p = Bun.spawnSync(
        ['git', '-C', checkout.path, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
        {
          // Status may otherwise take an optional lock to refresh index stat
          // data. Observation must not itself write to a watched checkout.
          env: { ...targetGitEnvironment(checkout.path), GIT_OPTIONAL_LOCKS: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      if (p.exitCode !== 0) {
        failures.push({
          ...checkout,
          error: p.stderr.toString().trim() || `git status exited ${p.exitCode}`,
        })
        continue
      }
      snapshots.push({ project: checkout.project, path: checkout.path, status: p.stdout.toString() })
    } catch (error) {
      failures.push({
        ...checkout,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { snapshots, failures }
}

/**
 * Cheap observation of registered main checkouts, outside a run's worktree.
 *
 * Porcelain status deliberately bounds the check: it sees tracked and
 * untracked working-tree changes without hashing every file in every project.
 * The exported observer retains its historical snapshots-only surface. Run
 * enforcement uses the fixed watch set and preserves sampling failures too.
 */
export function snapshotRegisteredCheckouts(
  additional: CheckoutToWatch[] = [],
): CheckoutStatusSnapshot[] {
  return sampleCheckouts(checkoutWatchSet(additional).watched).snapshots
}

/**
 * A pack is written before its disposable worktree exists, so callers naturally
 * name the checkout they are standing in. That path is an address, not review
 * content: once the tree has been copied, every occurrence must point at the
 * copy or an agent following the pack escapes the isolation boundary.
 */
function withoutTrailingSeparators(path: string): string {
  let end = path.length
  while (end > 1 && path[end - 1] === '/') end--
  return path.slice(0, end)
}

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

export function changedRegisteredCheckouts(
  before: CheckoutStatusSnapshot[], after: CheckoutStatusSnapshot[],
): OutsideWorktreeWrite[] {
  const prior = new Map(before.map((snapshot) => [snapshot.path, snapshot]))
  const changes: OutsideWorktreeWrite[] = []
  for (const current of after) {
    const original = prior.get(current.path)
    if (!original || original.status === current.status) continue
    changes.push({
      project: current.project,
      path: current.path,
      before: original.status,
      after: current.status,
    })
  }
  return changes
}

function boundedConfinementError(message: string): string {
  const bytes = Buffer.from(message)
  if (bytes.length <= 1500) return message
  const suffix = Buffer.from('\n… [error bounded to 1500 bytes]')
  return Buffer.from(bytes.subarray(0, 1500 - suffix.length))
    .toString('utf8').replace(/\uFFFD$/, '') + suffix.toString()
}

function escapedWriteError(changes: OutsideWorktreeWrite[]): string {
  const detail = changes.map((change) => {
    const porcelain = (status: string) => status
      ? status.split('\0').filter(Boolean).join('\n')
      : '(clean)'
    return `registered checkout ${change.project} at ${change.path}\n` +
      `before:\n${porcelain(change.before)}\nafter:\n${porcelain(change.after)}`
  }).join('\n\n')
  return boundedConfinementError(
    `persistent outside change observed during the run; the writer is not established:\n${detail}`,
  )
}

function confinementUnverifiedError(failures: CheckoutSampleFailure[]): string {
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
        if (statSync(p).mtimeMs < cutoff) {
          unlinkSync(p)
          db().query('UPDATE run SET prompt_path=NULL WHERE prompt_path=?').run(p)
          db().query('UPDATE run SET output_path=NULL WHERE output_path=?').run(p)
        }
      } catch { /* raced, or busy */ }
    }
  } catch { /* no directory yet; nothing to prune */ }
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
  cwd?: string
  /** Explicit routing attribution when the caller is outside the registered project. */
  repo?: string
  /** The run this one re-attempts, for `orch retry`. */
  retryOf?: number
  noFailover?: boolean
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
    session: string
    turn: number
    /** Inherited so the chain stays owned by the session that started it. */
    sessionId: string | null
    worktree: Worktree | null
  }
  /** Immutable explicit-review target inherited only by automatic failover. */
  resolvedReviewTarget?: { branch: string; commit: string; base: string }
}): Promise<RunResult> {
  writableDb()

  const requestedJob = job(opts.job)
  const writesJob = Boolean(requestedJob.needs.writesRepo)
  const repoJob = Boolean(requestedJob.needs.readsRepo)
  const forbidsRepo = requestedJob.needs.readsRepo === false
  const callerCwd = opts.cwd ?? process.cwd()
  const seed = preflight(
    opts.job, callerCwd, opts.seed, opts.key, opts.base,
    opts.resume?.worktree != null,
    opts.reserveId !== undefined,
    opts.lens, opts.resolvedReviewTarget ? undefined : opts.review, opts.carry,
  )
  const reviewTarget = opts.resolvedReviewTarget ?? resolveReviewTarget(
    opts.job, opts.cwd ?? process.cwd(), opts.review, opts.carry,
  )
  // Programmatic callers get the same ordering guarantee as the CLI: a bad
  // ref is refused before a run row or worktree exists.
  if (opts.base) {
    const internalRepositoryFailover = opts.automaticFailover && requestedJob.needs.readsRepo
    if (opts.job !== 'implement' && opts.job !== 'fix' && !internalRepositoryFailover) {
      throw new Error('--base is only valid for the implement and fix jobs')
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
        `INSERT INTO run (started_at,agent,job,repo,cwd,prompt_sha,prompt_bytes,prompt_head,
          status,session_id,failure_kind,error,docs_injected,mcp)
         VALUES (?,'(pending)',?,?,?,?,?,?,'failed',?,'harness',?,0,?) RETURNING id`,
      ).get(nowIso(), opts.job, opts.repo ?? repoOf(callerCwd), callerCwd, sha(originalPrompt),
        Buffer.byteLength(originalPrompt), originalPrompt.slice(0, 200).replace(/\s+/g, ' '),
        opts.ownerSession ?? sessionId(), message, storedMcpRequest(opts.mcp)) as { id: number }).id
      throw Object.assign(new Error(`run ${failedId} could not start: ${message}`), { runId: failedId })
    }
  }
  const docsSection = pack?.docs.length
    ? `WHAT THE OPERATOR WANTS YOU TO KNOW\n\n${pack.markdown}`
    : ''
  let prompt = writesJob && !opts.resume
    ? [
        workerPreamble(opts.job),
        infra ? `\nYOUR WORKTREE'S INFRASTRUCTURE\n\n${infra}` : '',
        docsSection ? `\n${docsSection}` : '',
        `\n---\n\nTHE SPEC\n\n${originalPrompt}`,
      ].filter(Boolean).join('\n')
    // A read-only worker gets a much shorter brief, and only on a first turn.
    : opts.resume
      ? packedResumePrompt(opts.job, originalPrompt, opts.resume.parent)
      : [repoJob ? READONLY_PREAMBLE : NO_REPO_PREAMBLE,
          infra ? `YOUR WORKTREE'S INFRASTRUCTURE\n\n${infra}` : '',
          docsSection, `---\n\n${originalPrompt}`]
          .filter(Boolean).join('\n\n')

  if (requestedJob.findings && !opts.resume) {
    prompt = `${REVIEW_SEVERITY_INSTRUCTION}\n\n${prompt}`
  }

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
    : pick(opts.job, opts.agent,
           Buffer.byteLength(prompt) + (requestedJob.findings ? CALIBRATION_SUFFIX_RESERVE_BYTES : 0) +
             (requiresCanonSource ? CANON_SOURCE_PROMPT_RESERVE_BYTES : 0),
           true, stackAt(callerCwd),
           { agents: opts.avoid, models: opts.distinctModels, model: opts.model },
           opts.probe, opts.lens)
  const a = AGENTS[name]!
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
    mcpMode && repoJob && a.caps.discoversMcpFromCwd && projectAt(callerCwd),
  )
  let mcpConnection = deferredCwdMcpPreflight
    ? null
    : probeRequestedMcp(opts.mcp, name, callerCwd)
  if (requiresCanonSource && !deferredCwdMcpPreflight) {
    const source = canonSourceFor(Boolean(mcpMode), mcpConnection, repoJob)
    prompt += `\n\n${canonSourceInstruction(source)}`
  }
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
  const vendorSession: string | null = opts.resume?.session ?? a.mintSession?.() ?? null

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
  const generatedSchema = requestedJob.name === 'issue-worker'
    ? ISSUE_WORKER_SCHEMA
    : writesJob ? WORKER_SCHEMA
      : requestedJob.findings ? REVIEW_SCHEMA
        : requestedJob.name === 'verify-claim' ? VERIFY_CLAIM_SCHEMA : null
  const originalSchemaPath = generatedSchema && !opts.schemaPath
    ? (() => {
        const p = join(runsDir, `${stamp}.schema.json`)
        writeFileSync(p, JSON.stringify(generatedSchema, null, 2))
        return p
      })()
    : opts.schemaPath
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
        `UPDATE run SET started_at=?, agent=?, job=?, repo=?, cwd=?, prompt_sha=?,
                        prompt_bytes=?, prompt_head=?, label=?, status='running', probe=?, retry_of=?,
                        route_reason=?, branch=?, parent_run_id=?, turn=?, vendor_session=?, docs_injected=?, doc_revisions=?, canon_sha=?,
                        launch_cwd=?, launch_seed=?, launch_key=?, launch_base=?, no_failover=?,
                        automatic_failover=?, review_ref=?, pid=?, mcp=?
          WHERE id=? RETURNING id`,
      ).get(
        nowIso(), name, opts.job, opts.repo ?? repoOf(callerCwd), callerCwd, sha(prompt),
        Buffer.byteLength(prompt), head, opts.label ?? null, opts.probe ? 1 : 0, opts.retryOf ?? null, reason,
        branchOf(callerCwd),
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
        opts.reserveId,
      ) as { id: number })
    : (db().query(
        `INSERT INTO run (started_at, agent, job, repo, cwd, prompt_sha, prompt_bytes, prompt_head, label, status, session_id, probe, retry_of, route_reason, branch, parent_run_id, turn, vendor_session, docs_injected, doc_revisions, canon_sha,
                          launch_cwd, launch_seed, launch_key, launch_base, no_failover,
                          automatic_failover, review_ref, pid, mcp)
         VALUES (?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      ).get(
        nowIso(), name, opts.job, opts.repo ?? repoOf(callerCwd), callerCwd,
        sha(prompt), Buffer.byteLength(prompt), head, opts.label ?? null,
        // A resumed turn INHERITS the owning session rather than taking the
        // one that answered. The chain is one unit of work and one thing to
        // judge, and letting a second session adopt it by answering a question
        // would be the ownership rule leaking through a new door — the same
        // door `--detach` had to be stopped from opening.
        opts.resume ? opts.resume.sessionId : (opts.ownerSession ?? sessionId()),
        opts.probe ? 1 : 0, opts.retryOf ?? null, reason, branchOf(callerCwd),
        opts.resume?.parent ?? null, opts.resume ? opts.resume.turn : 1,
        vendorSession,
        pack?.docs.length ?? 0, pack ? JSON.stringify(pack.docs.map((doc) => doc.revisionId)) : null,
        pack?.sha256 ?? null,
        launchCwd, launchSeed, launchKey, launchBase, noFailover ? 1 : 0,
        opts.automaticFailover ? 1 : 0, opts.review ?? null, process.pid, storedMcpRequest(opts.mcp),
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
  db().query(
    `UPDATE run SET stack=?, model=?, run_token=?, mcp=?, mcp_server=?,
                    mcp_connected=?, mcp_error=?, schema_path=?, lens=? WHERE id=?`,
  )
    .run(
      stackAt(callerCwd), opts.model ?? a.model, runToken,
      storedMcpRequest(opts.mcp), mcpConnection?.server ?? null,
      mcpConnection?.connected == null ? null : mcpConnection.connected ? 1 : 0,
      mcpConnection?.error ?? (mcpMode ? 'no registered project identifies the canonical MCP server' : null),
      opts.schemaPath ?? null, opts.lens ?? null, claim.id,
    )

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
      isolatedCwd = mkdtempSync(join(tmpdir(), `orch-no-repo-${claim.id}-`))
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
            'UPDATE run SET cwd=?, worktree=?, branch=?, base_commit=?, worktree_source=? WHERE id=?',
          ).run(
            created.path, created.path, created.branch || null,
            reviewTarget?.base ?? created.base, created.source ?? null, claim.id,
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
          `UPDATE run SET cwd=?, worktree=?, branch=?, base_commit=?, worktree_source=?, carry_happened=?,
                          carry_base_commit=?, carry_tracked_paths=?, carry_untracked_paths=? WHERE id=?`,
        ).run(
          inheritedWorktree.path, inheritedWorktree.path, inheritedWorktree.branch || null,
          reviewTarget?.base ?? inheritedWorktree.base, inheritedWorktree.source ?? null,
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
        const recorded = db().query(
          'SELECT worktree, worktree_source FROM run WHERE id=?',
        ).get(claim.id) as { worktree: string | null; worktree_source: string | null } | null
        assertGrokTrustEligible(cwd, recorded)
        const beforeTrust = grokTrustHeadings()
        mcpTrustGranted = true
        // Record the attempt before doctor: the trusted invocation may write its
        // store and then fail, and that remains a grant orch made.
        db().query('UPDATE run SET mcp_trust_granted=1 WHERE id=?').run(claim.id)
        try {
          mcpConnection = mcpConnectionFor(name, cwd, server, true)
        } finally {
          const added = addedGrokTrustHeadings(beforeTrust, grokTrustHeadings())
          db().query('UPDATE run SET mcp_trust_path=? WHERE id=?')
            .run(added.length ? JSON.stringify(added) : null, claim.id)
        }
      }
      if (mcpTrustGranted && mcpConnection.connected === false &&
          /folder untrusted|repo-local server not started/i.test(mcpConnection.error ?? '')) {
        throw new Error(
          `Grok remained untrusted after scoped trust for ${cwd}: ${mcpConnection.error}`,
        )
      }
      if (mcpConnection.connected === false && mcpMode === 'prefer') {
        mcpConnection = {
          ...mcpConnection,
          error: `mirror: ${mcpConnection.error ?? `server '${server}' could not be attached`}`,
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
      if (requiresCanonSource) {
        prompt += `\n\n${canonSourceInstruction(canonSourceFor(true, mcpConnection, repoJob))}`
        writeFileSync(promptPath.replace(/\.prompt\.txt$/, '.bound.txt'), prompt)
        db().query('UPDATE run SET prompt_sha=?, prompt_bytes=? WHERE id=?')
          .run(sha(prompt), Buffer.byteLength(prompt), claim.id)
      }
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
    throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), { runId: claim.id })
  }

  // Read-only Codex jobs keep scratch objects in this worktree's metadata and
  // read existing objects through a common-store alternate. Writing jobs use
  // the common store so commits survive removal of the disposable tree.
  const gitObjectEnvironment = gitObjectEnvironmentFor(name, requestedJob, worktree)
  const writableRoots = repoJob && worktree
    ? [worktreeGitDir(worktree.path),
        ...(writesJob ? workerSharedGitRoots(worktree.path, worktree.branch) : [])]
    : undefined
  const gitConfigEnvironment = worktree
    ? prepareSharedRefGuard(
        worktree.path,
        writesJob && requestedJob.name !== 'land' ? `refs/heads/${worktree.branch}` : undefined,
      )
    : undefined
  if (gitConfigEnvironment && writableRoots) {
    assertSharedRefGuardOutsideWritableRoots(gitConfigEnvironment.GIT_CONFIG_VALUE_0, writableRoots)
  }
  const argvOpts = {
    prompt,
    out: outPath,
    schema: a.caps.schema ? schemaPath : undefined,
    // A WRITING JOB ALWAYS GETS MCP, whether or not the caller asked for it.
    // The ask-server is delivered over MCP, and a worker told to escalate every
    // design decision with no way to escalate would have exactly one option
    // left: guess. The capability check still applies — an agent without MCP
    // falls back to the durable `status: blocked` protocol, which is why that
    // one remains the contract rather than an afterthought.
    mcp: usingMcp,
    trustCwd: mcpTrustGranted ? cwd : undefined,
    model: opts.model,
    write: writes,
    session: vendorSession ?? undefined,
    /**
     * A repository job writes inside its own disposable worktree; anything
     * else stays read-only. The job's declared `readsRepo` is the only input —
     * a caller flag would let any invocation widen its own sandbox.
     */
    sandbox: repoJob ? 'workspace-write' as SandboxLevel : 'read-only' as SandboxLevel,
    // Every repository job may write its own linked metadata. A writing worker
    // additionally writes immutable common objects and its run branch ref and
    // reflog; the reference hook refuses every other ref by exact name.
    writableRoots,
    gitObjectEnvironment,
    gitConfigEnvironment,
  }
  const argv = opts.resume
    ? a.resumeArgv!({ ...argvOpts, session: opts.resume.session })
    : a.argv(argvOpts)

  const sandboxRoot = (db().query(
    'SELECT COALESCE(parent_run_id,id) AS id FROM run WHERE id=?',
  ).get(claim.id) as { id: number }).id
  const sandboxRunDir = join(runsDir, `sandbox-${sandboxRoot}`)
  const sandboxSelection = selectReadonlySandbox({
    agent: name,
    readsRepo: repoJob,
    writesRepo: writesJob,
    worktree: worktree?.path ?? null,
    runsDir: sandboxRunDir,
    project: projectAt(callerCwd),
    readonlyNotes: toolFor(callerCwd)?.readonly_notes,
    override: process.env.ORCH_SANDBOX,
    path: process.env.PATH,
    localBaseUrl: LOCAL_BASE_URL,
  })
  const srtSettingsPath = sandboxSelection.profile
    ? join(sandboxRunDir, 'settings.json')
    : null
  const sandboxEnvironment = sandboxSelection.profile
    ? prepareSandboxHome(name, sandboxRunDir)
    : {}
  if (srtSettingsPath) writeFileSync(srtSettingsPath, JSON.stringify(sandboxSelection.profile, null, 2))
  const launchArgv = sandboxSelection.sandbox === 'srt'
    ? [SRT_BIN, '--settings', srtSettingsPath!, '--', a.bin, ...argv]
    : [a.bin, ...argv]
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
  let timedOut = false
  let exitCode = -1
  let output = ''
  let vendorTokens: number | null = null
  let costUsd: number | null = null
  let resolvedSession: string | null = vendorSession
  let contract: WorkerReply | null = null
  let contractObjects = 0
  let acceptedQuestions: ReturnType<typeof realQuestions> = []
  let droppedQuestions: ReturnType<typeof realQuestions> = []
  let status = 'failed'
  let error: string | null = null
  let failureKind: ReturnType<typeof classify> | null = null
  let outsideWrites: OutsideWorktreeWrite[] = []
  let confinementFailures: CheckoutSampleFailure[] = []
  // Start after orch's own worktree and hook setup, immediately before the
  // vendor process. The interval establishes when a change happened, not who
  // wrote it: an architect or concurrent landing can change a watched checkout.
  const callerWatch = worktree && !opts.resume
    ? [{ project: opts.repo ?? repoOf(callerCwd) ?? '(caller)', path: callerCwd }]
    : []
  const candidates = worktree
    ? checkoutWatchSet(callerWatch, worktree.path)
    : { watched: [], failures: [] }
  const sampledBefore = sampleCheckouts(candidates.watched)
  const skipped = [...candidates.failures, ...sampledBefore.failures]
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
  const beforeSample = { snapshots: sampledBefore.snapshots, failures: [] }
  const watchedCheckouts = beforeSample.snapshots.map(({ project, path }) => ({ project, path }))

  try {
    if (repoJob) {
      if (!worktree) throw new Error(`repository run ${claim.id} has no worktree to measure`)
      const inputTree = withoutProvisionedMcpConfig(
        worktree.path, provisionedMcpConfigLink, () => contentTree(worktree.path),
      )
      const headCommit = gitContext(worktree.path, 'rev-parse', '--verify', 'HEAD^{commit}')
      const measured = db().query('UPDATE run SET input_tree=?, head_commit=? WHERE id=?')
        .run(inputTree, headCommit, claim.id)
      if (measured.changes !== 1) throw new Error(`run ${claim.id} could not record its input tree`)
    }
    const p = Bun.spawn(launchArgv, {
      cwd,
      env: childEnv(a, claim.id, runToken, {
        ...(gitConfigEnvironment ?? {}), ...sandboxEnvironment,
      }),
      stdin: a.stdin ? new TextEncoder().encode(prompt) : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    proc = p
    live.add(p)
    // The VENDOR CLI pid. pid stays the worker's for the whole run: after the
    // agent exits the worker is still parsing output and writing questions, and
    // a reaper that tested this pid would mark the run stale under a process
    // about to write its real outcome.
    //
    // Recorded HERE, before the wait, not after it. Written afterwards it is
    // always the pid of a process that has already exited.
    db().query('UPDATE run SET agent_pid=? WHERE id=?').run(p.pid, claim.id)

    // The JOB's bound where it declares one, else the agent's. A job knows how
    // long its own shape of work takes; an agent only knows what it has been
    // asked before.
    const boundMs = job(opts.job).timeoutMs ?? a.timeoutMs
    timer = setTimeout(() => {
      timedOut = true
      try { p.kill('SIGTERM') } catch { /* already gone */ }
      // A CLI that ignores SIGTERM would otherwise keep the caller waiting for
      // ever, which is the thing the timeout exists to prevent.
      killer = setTimeout(() => { try { p.kill(9) } catch { /* already gone */ } }, 5_000)
    }, boundMs)

    const [stdout, stderr] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ])
    exitCode = await p.exited

    // Agents that report their own usage answer inside a JSON envelope; unwrap it
    // so the stored output is the reply and the token count is not lost.
    const reply = a.parseReply?.(stdout)
    const replyError = reply?.error ?? null
    const outputCeilingReached = !!reply && !reply.text.trim() &&
      a.outputCeilingStopReason !== null && reply.stopReason === a.outputCeilingStopReason
    vendorTokens = reply?.tokens ?? parseVendorTokens(stderr) ?? parseVendorTokens(stdout)
    costUsd = reply?.costUsd ?? null

    // The id an agent named for ITSELF, recovered now that it has run. Minted
    // ids are already in hand and must not be overwritten by a failed lookup.
    resolvedSession = vendorSession ??
      a.readSession?.({ stdout, cwd, prompt, startedAt: started }) ?? null

    if (replyError) {
      // The envelope says the reply failed, but stdout is still the transcript
      // of everything that happened before it did. Keep it raw: both ends of a
      // failure are evidence, and the vendor error alone is only one end.
      output = stdout
      writeFileSync(outPath, output)
    } else if (a.readsOut && existsSync(outPath)) output = readFileSync(outPath, 'utf8').trim()
    if (!replyError && !output) {
      output = (reply?.text ?? stdout).trim()
      if (output) writeFileSync(outPath, output)
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
    if (writesJob && output) {
      const parsed = parseWorkerReplyWithCount(
        output, requestedJob.name === 'issue-worker' ? ISSUE_WORKER_SCHEMA : WORKER_SCHEMA,
      )
      contract = parsed.reply as WorkerReply | null
      contractObjects = parsed.contractObjects
    }
    const questionsControlStatus = isAsking(contract) || contract?.status === 'done'
    acceptedQuestions = questionsControlStatus ? realQuestions(contract) : []
    const acceptedQuestionSet = new Set(acceptedQuestions)
    droppedQuestions = questionsControlStatus
      ? (contract?.questions ?? []).filter((item) => !acceptedQuestionSet.has(item))
      : []

    const completedReplyAtTimeout = contract?.status === 'done' ||
      (!writesJob && !replyError && !!output && !isNonAnswer(output))
    if (outputCeilingReached) {
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
      failureKind = classify(replyError, exitCode, timedOut)
    } else if (exitCode === 0 && isNonAnswer(output)) {
      // Exit 0 and non-empty, but what came back is the vendor saying it
      // failed. Recorded as the failure it is rather than stored as an answer:
      // a run nobody can use should cost the agent the same as one that
      // crashed, not sit in the table looking like a success until a person
      // reads 57 bytes and works it out.
      status = 'failed'
      error = errorTail(output)
      failureKind = classify(output, exitCode, timedOut)
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
      const terminalKind = classify(terminal, exitCode, timedOut)
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
      const terminalKind = classify(terminal, exitCode, timedOut)
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
      failureKind = status === 'failed' ? classify(error, exitCode, timedOut) : null
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
    if (proc) live.delete(proc)

    try {
      const afterSample = sampleCheckouts(watchedCheckouts)
      confinementFailures.push(...afterSample.failures.map((failure) => ({
        ...failure, error: `after snapshot: ${failure.error}`,
      })))
      outsideWrites = changedRegisteredCheckouts(
        beforeSample.snapshots, afterSample.snapshots,
      )
      db().query('UPDATE run SET outside_worktree_writes=? WHERE id=?')
        .run(JSON.stringify(outsideWrites), claim.id)
    } catch (e) {
      // A failure in the observation machinery itself cannot safely fabricate
      // which checkout was unreadable. Keep the original outcome and make the
      // harness fault visible; sampled checkout failures take the binding path.
      console.error(`orch: could not record outside-worktree writes for run ${claim.id}: ${e}`)
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

    if (contract?.status === 'done' && contract.files_changed?.length === 0 &&
        contract.tests?.ran === false && changes?.files.length === 0) {
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
    if (status === 'ok' && requestedJob.findings) {
      const review = parseReviewOutput(output)
      if (review) {
        const evidence = cleanReviewEvidence(claim.id, review)
        if (evidence.failure) {
          status = 'failed'
          error = evidence.failure
          failureKind = 'unevidenced'
        } else if (evidence.note) {
          error = error ? `${error}\n${evidence.note}` : evidence.note
        }
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
      status = 'failed'
      failureKind = 'confinement_unverified'
      error = confinementUnverifiedError(confinementFailures)
    } else if (outsideWrites.length) {
      status = 'failed'
      failureKind = 'escaped'
      error = escapedWriteError(outsideWrites)
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

    writeTransaction(() => {
      db().query(
        `UPDATE run SET latency_ms=?, exit_code=?, output_bytes=?, output_path=?, prompt_path=?,
                        vendor_tokens=?, vendor_cost_usd=?,
                        status=CASE WHEN status='stopped' THEN status ELSE ? END,
                        error=CASE WHEN status='stopped' THEN error ELSE ? END,
                        failure_kind=CASE WHEN status='stopped' THEN failure_kind ELSE ? END,
                        vendor_session=COALESCE(?, vendor_session) WHERE id=?`,
      ).run(
        Date.now() - started, exitCode, new TextEncoder().encode(output).byteLength, outPath, promptPath,
        vendorTokens, costUsd, status, error, failureKind, resolvedSession, claim.id,
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
    })
  }

  // Quota and auth stop this agent working until a person acts. Notify at the
  // moment it happens even though the failover path below can route around it.
  if (failureKind && NEEDS_HUMAN.includes(failureKind)) {
    notify(
      NEEDS_HUMAN_TITLE[failureKind]?.(name) ?? `${name} needs attention`,
      `${opts.job} failed. Routing will avoid it until it succeeds again.`,
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
              base_commit, head_commit, review_ref
         FROM run WHERE id=?`,
    ).get(attempts[0]!.id) as {
      prompt_path: string | null; launch_cwd: string | null; launch_seed: string | null
      launch_key: string | null; launch_base: string | null; no_failover: number
      session_id: string | null; mcp: number | null; mcp_error: string | null; schema_path: string | null
      probe: number; label: string | null; lens: string | null; repo: string | null
      base_commit: string | null; head_commit: string | null; review_ref: string | null
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
        return await run({
          job: opts.job,
          prompt: originalPrompt,
          agent: next.agent,
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

  if (status === 'failed') {
    throw Object.assign(new Error(`run ${claim.id} failed: ${error}`), { runId: claim.id })
  }
  return {
    id: claim.id, agent: name, reason, output, latencyMs: Date.now() - started, exitCode,
    vendorTokens, costUsd, outPath, worktree, changes, contract, status,
  }
}
