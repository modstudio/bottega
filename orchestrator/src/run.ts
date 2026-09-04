import {
  mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync, rmSync,
  statSync, unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import {
  classify, notify, isNonAnswer, detectBlockers, NEEDS_HUMAN, NEEDS_HUMAN_TITLE,
} from './failure.ts'
import {
  AGENTS, ensureLocalHealth, tryWake, readStrictCodexSchema, type SandboxLevel,
} from './agents.ts'
import { job, type Job } from './jobs.ts'
import { pick } from './route.ts'
import { db, nowIso, ROOT, DB_PATH, sessionId, resolveRootFromLastTurn } from './db.ts'
import {
  createWorktree, createWithTool, toolFor, changesIn, repoRootOf, resolveBase, worktreeGitDir,
  prepareWorktreeObjects, prepareSharedRefGuard, worktreeGitEnvironment, carryWorkingState,
  workerSharedGitRoots,
  assertCallerAncestry, withWorktreeCreateLock,
  removeFor, type Worktree,
  type WorktreeObjectEnvironment, validateSeedWithTool,
} from './worktree.ts'
import { recipeNotes } from './recipe.ts'
import {
  workerPreamble, workerResumeGuard, READONLY_PREAMBLE, NO_REPO_PREAMBLE, WORKER_SCHEMA, ISSUE_WORKER_SCHEMA, REVIEW_SCHEMA,
  parseWorkerReplyWithCount, isAsking,
  type WorkerReply,
} from './contract.ts'
import { CALIBRATION_SUFFIX_RESERVE_BYTES, calibrationLine, reviewCalibration } from './review.ts'
import { projectAt, stackAt } from './projects.ts'
import { docsForRun, docsMarkdown } from './docs.ts'

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
  /** Where a writing worker ran, and what it changed. Null for a read-only job. */
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
  agent?: string; schema?: string; mcp?: boolean; model?: string; probe?: boolean
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
  /** Disable automatic quota/auth failover for this whole chain. */
  noFailover?: boolean
  /** Carry the caller's uncommitted work into a newly cut worktree. Opt-in. */
  carry?: boolean
  /** Preserve the session that owns a successor root. */
  ownerSession?: string | null
  /** Resume only: everything needed to continue a worker where it stopped. */
  resume?: {
    parent: number; agent: string; session: string; turn: number
    sessionId: string | null
    worktree: { path: string; branch: string; base: string; repoRoot: string } | null
  }
}

/** Translate the detached wire format into the names run() consumes. */
export function detachedRunOptions(
  jobName: string, prompt: string, reserveId: number, spec: DetachSpec,
) {
  const {
    agent, schema, mcp, model, probe, label, lens, seed, key, repo, base, avoid,
    distinctModels, retryOf, cwd, noFailover, carry, ownerSession, resume,
  } = spec
  // Adding a field to DetachSpec must fail typechecking until it is handled here.
  const consumed: Required<Record<keyof DetachSpec, unknown>> = {
    agent, schema, mcp, model, probe, label, lens, seed, key, repo, base, avoid,
    distinctModels, retryOf, cwd, noFailover, carry, ownerSession, resume,
  }
  void consumed
  return {
    job: jobName, prompt, reserveId,
    agent, schemaPath: schema, mcp, model, probe, label, lens, seed, key, repo, base, avoid,
    distinctModels, retryOf, cwd, noFailover, carry, ownerSession, resume,
  }
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

/**
 * Ask the same client that will run the lens whether its project MCP can start.
 * Grok gates repo-local MCP behind folder trust separately from permission
 * mode; doctor checks discovery and the handshake without granting that trust.
 */
export function grokMcpConnection(
  bin: string, cwd: string, server: string, env: Record<string, string>,
): McpConnection {
  const p = Bun.spawnSync([bin, 'mcp', 'doctor', server, '--json'], {
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
function mcpConnectionFor(name: string, cwd: string, server: string): McpConnection {
  if (name === 'grok') {
    const grok = AGENTS.grok!
    return grokMcpConnection(grok.bin, cwd, server, childEnv(grok))
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

function probeRequestedMcp(mcp: boolean | undefined, agent: string, cwd: string): McpConnection | null {
  if (!mcp) return null
  const project = projectAt(cwd)
  if (!project) return null
  return mcpConnectionFor(agent, cwd, project.name)
}

/**
 * Refuse a --mcp dispatch that routing would send to an agent whose attach
 * we can prove failed — before a run row exists.
 *
 * Consults pick() for who will actually run. An unpinned job that prefers
 * Codex is not refused because grok happens to be eligible; a pinned Codex
 * dispatch is not refused because grok's doctor is red.
 */
export function preflightMcp(opts: {
  mcp?: boolean
  cwd: string
  job: string
  prompt: string
  agent?: string
  avoid?: string[]
  distinctModels?: string[]
  model?: string
}): void {
  if (!opts.mcp) return
  if (!projectAt(opts.cwd)) return
  const { agent: name } = pick(
    opts.job, opts.agent, opts.prompt.length, true, stackAt(opts.cwd),
    { agents: opts.avoid, models: opts.distinctModels, model: opts.model },
  )
  const connection = probeRequestedMcp(true, name, opts.cwd)
  if (!connection) return
  const why = mcpAttachRefusal(connection)
  if (why) throw new Error(why)
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
): string | undefined {
  if (depth() >= MAX_DEPTH) {
    throw new Error(
      `refusing to delegate at depth ${depth()}: this process is itself a delegated agent. ` +
        'Answer the question with the tools you have, or hand it back to the caller.',
    )
  }
  const j = job(jobName)
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
  if (jobName === 'review-lens' && repoRootOf(cwd) === null) {
    throw new Error(
      `a review lens reads a change, and ${cwd} is not inside a git checkout, so there is no change to read.\n` +
      `Run it from the checkout that holds the change.`,
    )
  }
  if (!j.needs.readsRepo) return seed
  // A key and a caller-selected seed are required only for a writing job's NEW
  // worktree. A read-only job still passes a project-declared `none` explicitly:
  // it is the settled answer for a job that provably needs no database. A resumed
  // turn works in the tree its parent already has, so demanding them again blocks
  // every ruling.
  if (reusesWorktree) return seed
  const project = projectAt(cwd)
  const tool = project?.settings.worktree ?? null
  // `none` is a project-declared seed, not an orch default. Matching the exact
  // literal keeps this inference narrow: another project-specific label is not
  // silently reinterpreted as "no database" merely because it sounds similar.
  const effectiveSeed = seed ?? (!writesJob && tool?.seeds?.includes('none') ? 'none' : undefined)
  const keyPattern = tool?.keyPattern ?? '^[A-Z][A-Z0-9]+-[0-9]+$'
  const problems: string[] = []
  if (key && !new RegExp(keyPattern).test(key)) {
    problems.push(`key "${key}" does not match ${keyPattern}`)
  }
  if (tool?.create && !tool.branch) {
    problems.push(
      `this project's worktree create command has no branch template.\n` +
      `Set the worktree branch key with:\n` +
      `  orch project set ${project!.name} --settings '{"worktree":{"branch":"<template>"}}'`,
    )
  }
  if (baseRef && tool?.create && !tool.create.includes('{base}')) {
    problems.push(
      `this project's command-based worktree path cannot honor --base because its create ` +
      `template does not contain {base}`,
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
      `  --seed ${tool.seeds.join('\n  --seed ')}\n\n` +
      `Choosing is the architect's call: it depends on what the task touches.`,
    )
  } else if (writesJob && tool?.create?.includes('{seed}') && !effectiveSeed) {
    problems.push(
      `this project's worktree create command contains {seed}, so a seed is required.\n` +
      `  --seed <value>`,
    )
  } else if (!writesJob && tool?.seeds?.length && !effectiveSeed) {
    problems.push(
      `project ${project!.name} requires an explicit seed, but its seed list has no ` +
      `"none" option for a read-only job that needs no database.`,
    )
  }
  if (problems.length) throw new Error(problems.join('\n'))
  if (tool?.create && !seedAlreadyValidated) validateSeedWithTool(cwd, effectiveSeed)
  return effectiveSeed
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
   * `ORCH_DB` defaults to `orch.db` next to the running `cli.ts`, and a worker
   * runs inside a worktree — which has its own `orchestrator/` directory and no
   * database, `orch.db` being untracked. So a worker asking the orchestrator
   * anything got a freshly created, empty file: `orch project list --json`
   * answered `[]`, and a worker reading that would conclude this machine has no
   * projects rather than that it was looking in the wrong place.
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
function branchOf(cwd: string): string | null {
  try {
    const p = Bun.spawnSync(['git', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { env: { ...process.env, ...worktreeGitEnvironment(cwd) }, stdout: 'pipe', stderr: 'ignore' })
    if (p.exitCode !== 0) return null
    const b = new TextDecoder().decode(p.stdout).trim()
    return b && b !== 'HEAD' ? b.slice(0, 200) : null
  } catch { return null }
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
 * Where prompt and output files live. Per-checkout by default; ORCH_RUNS
 * redirects it, the same seam ORCH_DB is for the database. The suite sets that
 * so two copies in one tree do not share filenames and delete each other's.
 */
export const RUNS_DIR = process.env.ORCH_RUNS ?? join(ROOT, 'runs')

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

export async function run(opts: {
  job: string
  prompt: string
  agent?: string
  schemaPath?: string
  mcp?: boolean
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
}): Promise<RunResult> {

  const seed = preflight(
    opts.job, opts.cwd ?? process.cwd(), opts.seed, opts.key, opts.base,
    opts.resume?.worktree != null,
    opts.reserveId !== undefined,
    opts.lens,
  )
  // Programmatic callers get the same ordering guarantee as the CLI: a bad
  // ref is refused before a run row or worktree exists.
  if (opts.base) {
    if (opts.job !== 'implement') throw new Error('--base is only valid for the implement job')
    resolveBase(opts.cwd ?? process.cwd(), opts.base)
  }
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
  const requestedJob = job(opts.job)
  const writesJob = Boolean(requestedJob.needs.writesRepo)
  const repoJob = Boolean(requestedJob.needs.readsRepo)
  const forbidsRepo = requestedJob.needs.readsRepo === false
  const callerCwd = opts.cwd ?? process.cwd()
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
    const generated = tool.recipe
      ? recipeNotes(tool.recipe, '<this worktree\'s database>', '')
      : ''
    return [tool.notes ?? '', generated].filter(Boolean).join('\n\n')
  })()
  const originalPrompt = opts.prompt
  const injectedDocs = opts.resume ? [] : docsForRun({ job: opts.job, cwd: callerCwd })
  const docsSection = injectedDocs.length
    ? `WHAT THE OPERATOR WANTS YOU TO KNOW\n\n${docsMarkdown(injectedDocs)}`
    : ''
  const resumeReminder = opts.resume
    ? (() => {
        const root = db().query('SELECT prompt_path FROM run WHERE id=?').get(opts.resume.parent) as
          { prompt_path: string | null } | null
        // A root whose prompt has aged out of runs/ (30 days) is still
        // resumable: the reminder is a courtesy to the worker, not a
        // precondition, and refusing here would strand the chain.
        if (!root?.prompt_path || !existsSync(root.prompt_path)) return ''
        return [
          'REMINDER FROM THE ORIGINAL SPEC',
          '',
          readFileSync(root.prompt_path, 'utf8').slice(0, 600),
          '',
          'Do not decide what the spec did not settle; ask.',
          workerResumeGuard(opts.job),
        ].join('\n')
      })()
    : ''
  const provenance = opts.job === 'review-lens'
    ? 'Provenance: state the source you measured against.'
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
      ? (resumeReminder ? `${resumeReminder}\n\n---\n\n${originalPrompt}` : originalPrompt)
      : [repoJob ? READONLY_PREAMBLE : NO_REPO_PREAMBLE,
          provenance, docsSection, `---\n\n${originalPrompt}`]
          .filter(Boolean).join('\n\n')

  // A resumed turn is NOT routed. The conversation lives inside one vendor's
  // session, so "which agent is best at this job" is not a question that can be
  // asked any more — re-routing would resume a session the new agent has never
  // seen. Recorded with a reason that says so, rather than an empty one.
  const { agent: name, reason } = opts.resume
    ? { agent: opts.resume.agent, reason: `resumed run ${opts.resume.parent} (turn ${opts.resume.turn})` }
    // The STACK steers the route: an agent strong on PHP and weak on a Vue
    // component is two different agents to a router, and only this tells them
    // apart. Backs off to job-wide evidence until a stack cell has earned it.
    : pick(opts.job, opts.agent,
           Buffer.byteLength(prompt) + (requestedJob.findings ? CALIBRATION_SUFFIX_RESERVE_BYTES : 0),
           true, stackAt(callerCwd),
           { agents: opts.avoid, models: opts.distinctModels, model: opts.model })
  const a = AGENTS[name]!
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
   * A proven-failed MCP attach is a dispatch that did not happen, not a run
   * with a bad outcome. Probe after routing (a red grok doctor is evidence
   * about grok, not about Codex) and before a row exists.
   *
   * A reserved placeholder was claimed by detach() after the same check; if
   * routing here disagrees and grok cannot attach, delete that placeholder
   * rather than converting a non-event into a failed row.
   */
  const mcpConnection = probeRequestedMcp(opts.mcp, name, callerCwd)
  const mcpWhy = mcpConnection ? mcpAttachRefusal(mcpConnection) : null
  if (mcpWhy) {
    if (opts.reserveId) db().query('DELETE FROM run WHERE id=?').run(opts.reserveId)
    throw new Error(mcpWhy)
  }

  /** Whether the requested product is a diff, rather than review findings. */
  const usingMcp = (opts.mcp || writesJob) && a.caps.mcp
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
    : writesJob ? WORKER_SCHEMA : requestedJob.findings ? REVIEW_SCHEMA : null
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
  const launchKey = inheritedLaunch?.launch_key ?? opts.key ?? null
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
                        route_reason=?, branch=?, parent_run_id=?, turn=?, vendor_session=?, docs_injected=?,
                        launch_cwd=?, launch_seed=?, launch_key=?, launch_base=?, no_failover=?,
                        automatic_failover=?, pid=?
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
        injectedDocs.length,
        launchCwd, launchSeed, launchKey, launchBase, noFailover ? 1 : 0,
        opts.automaticFailover ? 1 : 0, process.pid,
        opts.reserveId,
      ) as { id: number })
    : (db().query(
        `INSERT INTO run (started_at, agent, job, repo, cwd, prompt_sha, prompt_bytes, prompt_head, label, status, session_id, probe, retry_of, route_reason, branch, parent_run_id, turn, vendor_session, docs_injected,
                          launch_cwd, launch_seed, launch_key, launch_base, no_failover,
                          automatic_failover, pid)
         VALUES (?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
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
        injectedDocs.length,
        launchCwd, launchSeed, launchKey, launchBase, noFailover ? 1 : 0,
        opts.automaticFailover ? 1 : 0, process.pid,
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
      opts.mcp ? 1 : 0, mcpConnection?.server ?? null,
      mcpConnection?.connected == null ? null : mcpConnection.connected ? 1 : 0,
      mcpConnection?.error ?? (opts.mcp ? 'no registered project identifies the canonical MCP server' : null),
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
            'UPDATE run SET cwd=?, worktree=?, branch=?, base_commit=? WHERE id=?',
          ).run(created.path, created.path, created.branch, created.base, claim.id)
          if (result.changes !== 1) throw new Error(`run ${claim.id} could not record its worktree`)
        }
        worktree = withWorktreeCreateLock(repoRoot, () => {
          let created: Worktree
          if (tool) {
            // The PROJECT owns its worktrees. A bare `git worktree add` here would
            // produce a directory with no .env, no vendor and no database, in which
            // every test the worker runs is meaningless and green.
            created = createWithTool(
              tool, callerCwd, claim.id, seed, opts.key, opts.base, recordWorktree,
            )
          } else {
            // INHERITED on a resume, and this is the point of the whole exercise:
            // the worker is mid-edit in that tree, and cutting a fresh one would
            // answer its question into an empty checkout and throw away everything
            // it had built.
            created = createWorktree(callerCwd, claim.id, opts.base, recordWorktree)
          }
          const current = db().query('SELECT status FROM run WHERE id=?').get(claim.id) as
            { status: string }
          if (current.status === 'stopped') {
            const cleanup = removeFor(created, created.repoRoot)
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
            assertCallerAncestry(callerCwd, created)
            carried = opts.carry
              ? carryWorkingState(callerCwd, created)
              : { base: created.base, tracked: [], untracked: [] }
          } catch (e) {
            const cleanup = removeFor(created, created.repoRoot)
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
        `UPDATE run SET cwd=?, worktree=?, branch=?, base_commit=?, carry_happened=?,
                        carry_base_commit=?, carry_tracked_paths=?, carry_untracked_paths=? WHERE id=?`,
      ).run(
        worktree.path, worktree.path, worktree.branch, worktree.base,
        carried ? (carried.tracked.length + carried.untracked.length > 0 ? 1 : 0) : null,
        carried?.base ?? null,
        carried ? JSON.stringify(carried.tracked) : null,
        carried ? JSON.stringify(carried.untracked) : null,
        claim.id,
      )
      cwd = worktree.path
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
  const gitConfigEnvironment = worktree
    ? prepareSharedRefGuard(
        worktree.path,
        writesJob && requestedJob.name !== 'land' ? `refs/heads/${worktree.branch}` : undefined,
      )
    : undefined
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
    writableRoots: repoJob && worktree
      ? [worktreeGitDir(worktree.path),
          ...(writesJob ? workerSharedGitRoots(worktree.path, worktree.branch) : [])]
      : undefined,
    gitObjectEnvironment,
    gitConfigEnvironment,
  }
  const argv = opts.resume
    ? a.resumeArgv!({ ...argvOpts, session: opts.resume.session })
    : a.argv(argvOpts)

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
  let status = 'failed'
  let error: string | null = null
  let failureKind: ReturnType<typeof classify> | null = null

  try {
    const p = Bun.spawn([a.bin, ...argv], {
      cwd,
      env: childEnv(a, claim.id, runToken, gitConfigEnvironment),
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

    if (timedOut && contract?.status === 'done') {
      /**
       * IT FINISHED, AND THEN WE KILLED IT.
       *
       * The agent wrote a complete reply and carried on — running the project's
       * gates, in the case that found this: fifteen files, PHPStan and PHPUnit
       * in Docker, then our twenty-minute bound fired. Recorded as a timeout,
       * that reads as "produced nothing in twenty minutes" and charges the
       * agent for work it had already delivered; the session only had the
       * result because it happened to see it on stdout.
       *
       * The reply is on disk either way, so believe it. The kill is still
       * worth knowing about — the bound may be too short for this job — but it
       * is a note on a successful run, not a failure.
       */
      status = 'ok'
      error = null
      failureKind = null
      console.error(
        `orch: run ${claim.id} had already returned a complete reply when the ` +
        `${Math.round(boundMs / 60_000)}m bound killed it. Recorded ok; the bound may be short.`,
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
    } else if (contract && isAsking(contract) && contract.questions?.length) {
      // `asking`, not `blocked`: the worker is doing exactly what it was told
      // to. The word matters because a `blocker` in this system is the
      // opposite — an environment problem — and on a page they read alike.
      status = 'asking'
      error = null
      failureKind = null
    } else if (isAsking(contract)) {
      /**
       * Blocked with nothing to answer is a DEAD END, not a pause.
       *
       * The schema permits `questions: null`, so a worker can stop and say it
       * is stuck without saying what it is stuck on. Recorded as blocked, that
       * run shows nothing in `orch inbox`, has nothing `orch answer` can rule
       * on, and can never be resumed or scored — it sits in the table for ever
       * looking like a question somebody forgot. A failure it can be retried
       * from is strictly better than a state with no exit.
       */
      status = 'failed'
      error = errorTail(
        'the worker stopped to ask but named no question, so there is nothing ' +
        `to rule on and nothing to resume:\n${output}`,
      )
      failureKind = 'other'
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
        (terminalKind === 'quota' || terminalKind === 'auth' ? `${terminal}\n` : '') +
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
      if (terminalKind === 'quota' || terminalKind === 'auth') {
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
    error = errorTail(String((e as Error)?.stack ?? e))
    failureKind = 'other'
  } finally {
    if (timer) clearTimeout(timer)
    if (killer) clearTimeout(killer)
    if (proc) live.delete(proc)

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
      try { changes = changesIn(worktree) } catch (e) {
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
    if (contractObjects > 1) {
      const note = `${contractObjects} contract objects in output; took the last`
      error = error ? `${error}\n${note}` : note
    }

    /**
     * The questions are written in the SAME `finally` as the row, so a blocked
     * run cannot exist without them. Split across two statements, a crash in
     * between would leave a run marked `blocked` with nothing to answer — which
     * looks identical to a run waiting on a ruling nobody has given, and would
     * sit in the inbox for ever.
     */
    if (contract && isAsking(contract) && contract.questions?.length) {
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
      for (const item of contract.questions) {
        if (already.has(norm(item.question))) continue
        q.run(
          claim.id, nowIso(), item.question,
          item.options?.length ? JSON.stringify(item.options) : null,
          item.recommendation ?? null, item.why ?? null,
        )
        already.add(norm(item.question))
      }
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
        `UPDATE run SET files_changed=?, lines_added=?, lines_removed=?,
                        tests_ran=?, tests_passed=?, deviations=?, escalations=? WHERE id=?`,
      ).run(
        changes?.files.length ?? null,
        changes?.insertions ?? null,
        changes?.deletions ?? null,
        contract?.tests ? (contract.tests.ran ? 1 : 0) : null,
        contract?.tests?.passed === undefined ? null : contract.tests.passed ? 1 : 0,
        contract?.deviations?.length ?? null,
        contract?.questions?.length ?? null,
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
     * Rolling the state up here means every existing query keeps working
     * untouched: one row per unit of work, holding where that work has got to,
     * with the children recording what each turn cost.
     */
    if (opts.resume) {
      db().query(
        `UPDATE run SET
           status=CASE WHEN status='stopped' THEN status ELSE ? END,
           error=CASE WHEN status='stopped' THEN error ELSE ? END
         WHERE id=?`,
      )
        .run(status, error, opts.resume.parent)
      resolveRootFromLastTurn(db(), opts.resume.parent)
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

  if (status === 'failed' && (failureKind === 'quota' || failureKind === 'auth')) {
    // The vendor is normally gone already. This is deliberately the same PID
    // termination primitive used by `orch stop`, excluding this coordinator:
    // it still has to route and run the successor before it may exit.
    terminateRunProcesses(claim.id, [process.pid])

    const attempts = failoverAttempts(claim.id)
    const tried = attempts.map((attempt) => attempt.agent)
    const first = db().query(
      `SELECT prompt_path, launch_cwd, launch_seed, launch_key, launch_base,
              no_failover, session_id, mcp, schema_path, probe, label, lens, repo, base_commit
         FROM run WHERE id=?`,
    ).get(attempts[0]!.id) as {
      prompt_path: string | null; launch_cwd: string | null; launch_seed: string | null
      launch_key: string | null; launch_base: string | null; no_failover: number
      session_id: string | null; mcp: number | null; schema_path: string | null
      probe: number; label: string | null; lens: string | null; repo: string | null; base_commit: string | null
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
          mcp: !!first.mcp,
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
          // Prefer the immutable cut point once a writing tree exists.
          base: writesJob ? (first.base_commit ?? first.launch_base ?? undefined) : undefined,
          avoid: opts.avoid,
          carry: opts.carry,
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
