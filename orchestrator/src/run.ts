import { mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  classify, notify, isNonAnswer, detectBlockers, NEEDS_HUMAN, NEEDS_HUMAN_TITLE,
} from './failure.ts'
import {
  AGENTS, ensureLocalHealth, tryWake, readStrictCodexSchema, type SandboxLevel,
} from './agents.ts'
import { job } from './jobs.ts'
import { pick } from './route.ts'
import { db, nowIso, ROOT, DB_PATH, sessionId } from './db.ts'
import {
  createWorktree, createWithTool, toolFor, changesIn, repoRootOf, resolveBase, worktreeGitDir,
  prepareWorktreeObjects, worktreeGitEnvironment, type Worktree,
} from './worktree.ts'
import { recipeNotes } from './recipe.ts'
import {
  workerPreamble, workerResumeGuard, READONLY_PREAMBLE, WORKER_SCHEMA,
  parseWorkerReplyWithCount, isAsking,
  type WorkerReply,
} from './contract.ts'
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

export type DetachSpec = {
  agent?: string; schema?: string; mcp?: boolean; model?: string; probe?: boolean
  label?: string
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
    agent, schema, mcp, model, probe, label, seed, key, repo, base, avoid,
    distinctModels, retryOf, cwd, resume,
  } = spec
  // Adding a field to DetachSpec must fail typechecking until it is handled here.
  const consumed: Required<Record<keyof DetachSpec, unknown>> = {
    agent, schema, mcp, model, probe, label, seed, key, repo, base, avoid,
    distinctModels, retryOf, cwd, resume,
  }
  void consumed
  return {
    job: jobName, prompt, reserveId,
    agent, schemaPath: schema, mcp, model, probe, label, seed, key, repo, base, avoid,
    distinctModels, retryOf, cwd, resume,
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

export const depth = () => Number(process.env.ORCH_DEPTH ?? 0)

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
): void {
  if (depth() >= MAX_DEPTH) {
    throw new Error(
      `refusing to delegate at depth ${depth()}: this process is itself a delegated agent. ` +
        'Answer the question with the tools you have, or hand it back to the caller.',
    )
  }
  const j = job(jobName)
  if (jobName === 'review-lens' && repoRootOf(cwd) === null) {
    throw new Error(
      `a review lens reads a change, and ${cwd} is not inside a git checkout, so there is no change to read.\n` +
      `Run it from the checkout that holds the change. (Run 675 was launched from a scratchpad and reported ` +
      `"0 of 0 files" as if that were a finding.)`,
    )
  }
  if (!j.needs.writesRepo) return
  // A key and a seed exist to name and fill a NEW worktree. A resumed turn works in
  // the one its parent already has, so demanding them again blocks every ruling.
  if (reusesWorktree) return
  const project = projectAt(cwd)
  const tool = project?.settings.worktree ?? null
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
  if (tool?.branch?.includes('{key}') && !key) {
    problems.push(
      `this project's branch names must carry a ticket key (${tool.branch}), and orch will ` +
      `not invent one.\n  --key <KEY-123>`,
    )
  }
  if (tool?.seeds?.length && !seed) {
    problems.push(
      `this project requires a database size for a new worktree, and has no default.\n` +
      `  --seed ${tool.seeds.join('\n  --seed ')}\n\n` +
      `Choosing is the architect's call: it depends on what the task touches.`,
    )
  } else if (tool?.create?.includes('{seed}') && !seed) {
    problems.push(
      `this project's worktree create command contains {seed}, so a seed is required.\n` +
      `  --seed <value>`,
    )
  }
  if (tool?.seeds?.length && seed && !tool.seeds.includes(seed)) {
    problems.push(
      `unknown seed "${seed}"; this project lists:\n` +
      `  --seed ${tool.seeds.join('\n  --seed ')}`,
    )
  }
  if (problems.length) throw new Error(problems.join('\n'))
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
  return { ...env, ...(a.env?.() ?? {}) }
}

/**
 * Children alive right now, so a signal can take them down with us.
 *
 * Without this, SIGTERM to `orch do` leaves the agent reparented to init with
 * nobody left to record what it did: the row claims to be running for ever, and
 * a subscription keeps being spent on an answer no one will read.
 */
const live = new Set<{ kill(sig?: number | string): void }>()
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

/** `git status --porcelain`, or null where the question cannot be asked. */
function porcelain(cwd: string): string | null {
  try {
    const p = Bun.spawnSync(['git', '-C', cwd, 'status', '--porcelain'],
      { env: { ...process.env, ...worktreeGitEnvironment(cwd) }, stdout: 'pipe', stderr: 'ignore' })
    return p.exitCode === 0 ? p.stdout.toString() : null
  } catch { return null }
}

/**
 * What changed in a tree we are NOT managing, between two porcelain readings.
 *
 * Compared rather than merely checked for emptiness: these checkouts are dirty
 * most of the time, and "the tree has uncommitted changes" says nothing. What
 * matters is whether THIS run added any.
 */
/**
 * What a read-only run did to a tree it was never supposed to touch.
 *
 * THIS WATCHED THE WRONG DIRECTION. It reported only lines that APPEARED, so a
 * run that created a stray file was caught and a run that DESTROYED work was
 * not — and destroying work is the harmful case. One session had seven
 * files of uncommitted review fixes in its checkout; a read-only lens ran, the
 * files went back to HEAD, and the run reported that "the tracked worktree
 * remains clean". Nothing in orch said a word, because clean is the absence of
 * lines and absence was all this function ignored.
 *
 * Both directions now, and vanished lines are named first: a file that stopped
 * being modified is uncommitted work that no longer exists, and there is no
 * reflog entry to recover it from.
 */
function dirtiedTree(cwd: string, before: string | null): string | null {
  if (before === null) return null
  const after = porcelain(cwd)
  if (after === null || after === before) return null
  const lines = (s: string) => s.split('\n').filter((l) => l.trim())
  const was = new Set(lines(before))
  const now = new Set(lines(after))
  const gone = [...was].filter((l) => !now.has(l))
  const added = [...now].filter((l) => !was.has(l))
  const out = [
    ...(gone.length
      ? ['UNCOMMITTED WORK THAT IS NO LONGER THERE — this is not recoverable:',
         ...gone.slice(0, 20)]
      : []),
    ...(added.length ? ['appeared:', ...added.slice(0, 20)] : []),
  ]
  return out.length ? out.join('\n') : null
}

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
  model?: string
  cwd?: string
  /** Explicit routing attribution when the caller is outside the registered project. */
  repo?: string
  /** The run this one re-attempts, for `orch retry`. */
  retryOf?: number
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

  preflight(
    opts.job, opts.cwd ?? process.cwd(), opts.seed, opts.key, opts.base,
    opts.resume?.worktree != null,
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
  const writesJob = Boolean(job(opts.job).needs.writesRepo)
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
    if (!writesJob) return ''
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
  const prompt = writesJob && !opts.resume
    ? [
        workerPreamble(opts.job),
        infra ? `\nYOUR WORKTREE'S INFRASTRUCTURE\n\n${infra}` : '',
        docsSection ? `\n${docsSection}` : '',
        `\n---\n\nTHE SPEC\n\n${originalPrompt}`,
      ].filter(Boolean).join('\n')
    // A read-only worker gets a much shorter brief, and only on a first turn.
    : opts.resume
      ? (resumeReminder ? `${resumeReminder}\n\n---\n\n${originalPrompt}` : originalPrompt)
      : [READONLY_PREAMBLE, docsSection, `---\n\n${originalPrompt}`].filter(Boolean).join('\n\n')

  // A resumed turn is NOT routed. The conversation lives inside one vendor's
  // session, so "which agent is best at this job" is not a question that can be
  // asked any more — re-routing would resume a session the new agent has never
  // seen. Recorded with a reason that says so, rather than an empty one.
  const { agent: name, reason } = opts.resume
    ? { agent: opts.resume.agent, reason: `resumed run ${opts.resume.parent} (turn ${opts.resume.turn})` }
    // The STACK steers the route: an agent strong on PHP and weak on a Vue
    // component is two different agents to a router, and only this tells them
    // apart. Backs off to job-wide evidence until a stack cell has earned it.
    // The last argument is the guard: a read-only job asking for MCP tools must
    // not be routed to an agent that can only have tools WITH a writable disk,
    // because a read-only job runs in the caller's own checkout.
    : pick(opts.job, opts.agent, prompt.length, true, stackAt(callerCwd),
           Boolean(opts.mcp) && !writesJob,
           { agents: opts.avoid, models: opts.distinctModels, model: opts.model })
  const a = AGENTS[name]!

  /**
   * Whether this job writes is read off the JOB, never off a flag.
   *
   * A caller cannot ask for a writable sandbox on a read-only job, because the
   * only thing that opens one is the job's own declared `writesRepo`. That
   * keeps the blast radius a property of the work rather than of whoever typed
   * the command, and it is why `pick()` can be trusted to have excluded every
   * agent that cannot write: eligibility and sandbox read the same field.
   */
  /**
   * Whether this run gets a WRITABLE DISK, which is not the same question as
   * whether the job writes.
   *
   * codex needs `--approve-for-me` to make MCP tool calls at all, and that flag
   * implies workspace-write. So an `mcp-query` — nominally read-only — was
   * being handed an editable copy of the caller's real checkout, with nothing
   * in the flag list saying so. Anything that CAN write gets isolated, because
   * the worktree is the actual protection and the sandbox flag is just how the
   * agent was configured.
   */
  const usingMcp = (opts.mcp || writesJob) && a.caps.mcp
  /**
   * ONLY A JOB THAT DECLARES `writesRepo` GETS A WORKTREE.
   *
   * This briefly also isolated any run whose sandbox happened to be writable —
   * codex's `--approve-for-me`, required for MCP, implies workspace-write — on
   * the reasoning that anything which CAN write should be contained. The
   * reasoning was sound and the cure was far worse than the disease.
   *
   * A review lens uses MCP to fetch its own prompt, so it was suddenly
   * "writing": in one Laravel app that meant invoking the project's full worktree
   * tooling, which demands a database size and a ticket key. Six read-only
   * lenses failed outright, and a job that had run fine all day stopped
   * working. A read-only review does not need a database; it needs to read the
   * tree the pack names.
   *
   * The residual risk is real and stated rather than fixed: an mcp job on codex
   * has a writable sandbox pointed at the caller's checkout. What bounds it is
   * that the job never asks the agent to change anything — and `dirtiedTree`
   * below reports it if one does, which is a cheaper and more honest guard than
   * provisioning a database to prevent an edit nobody requested.
   */
  const writes = writesJob

  // Minted before the spawn when the agent lets us choose, so the resume handle
  // exists even for a worker that dies mid-turn. codex and qwen name their own
  // and are read back afterwards instead.
  const vendorSession: string | null = opts.resume?.session ?? a.mintSession?.() ?? null

  const runsDir = join(ROOT, 'runs')
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
  const originalSchemaPath = writesJob && !opts.schemaPath
    ? (() => {
        const p = join(runsDir, `${stamp}.schema.json`)
        writeFileSync(p, JSON.stringify(WORKER_SCHEMA, null, 2))
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
                        route_reason=?, branch=?, parent_run_id=?, turn=?, vendor_session=?, docs_injected=?
          WHERE id=? RETURNING id`,
      ).get(
        nowIso(), name, opts.job, opts.repo ?? repoOf(callerCwd), callerCwd, sha(prompt),
        prompt.length, head, opts.label ?? null, opts.probe ? 1 : 0, opts.retryOf ?? null, reason,
        branchOf(callerCwd),
        opts.resume?.parent ?? null, opts.resume ? opts.resume.turn : 1,
        // Known before spawn: minted (grok) or inherited on resume. A SIGKILL
        // or an exec.ts bootstrap failure never reaches the finally that used
        // to be the only write, and continue then refused a chain whose parent
        // already knew the id.
        vendorSession,
        injectedDocs.length,
        opts.reserveId,
      ) as { id: number })
    : (db().query(
        `INSERT INTO run (started_at, agent, job, repo, cwd, prompt_sha, prompt_bytes, prompt_head, label, status, session_id, probe, retry_of, route_reason, branch, parent_run_id, turn, vendor_session, docs_injected)
         VALUES (?,?,?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?,?) RETURNING id`,
      ).get(
        nowIso(), name, opts.job, opts.repo ?? repoOf(callerCwd), callerCwd,
        sha(prompt), prompt.length, head, opts.label ?? null,
        // A resumed turn INHERITS the owning session rather than taking the
        // one that answered. The chain is one unit of work and one thing to
        // judge, and letting a second session adopt it by answering a question
        // would be the ownership rule leaking through a new door — the same
        // door `--detach` had to be stopped from opening.
        opts.resume ? opts.resume.sessionId : sessionId(),
        opts.probe ? 1 : 0, opts.retryOf ?? null, reason, branchOf(callerCwd),
        opts.resume?.parent ?? null, opts.resume ? opts.resume.turn : 1,
        vendorSession,
        injectedDocs.length,
      ) as { id: number })
  const runToken = randomUUID()
  db().query('UPDATE run SET stack=?, model=?, run_token=?, mcp=?, schema_path=? WHERE id=?')
    .run(
      stackAt(callerCwd), opts.model ?? a.model, runToken,
      opts.mcp ? 1 : 0, opts.schemaPath ?? null, claim.id,
    )

  /**
   * A writing worker never runs in the caller's checkout.
   *
   * Cut AFTER the row exists, because the worktree is named by run id and the
   * id is what makes the mapping between a row and a directory total in both
   * directions. That ordering means a repository that cannot host a worktree
   * leaves a row behind — which is the right way round: the `finally` below
   * writes it terminal, so the failure is recorded rather than silent.
   */
  let worktree: Worktree | null = opts.resume?.worktree ?? null
  let changes: import('./worktree.ts').Changes | null = null
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
    if (writes) {
      // A job that WRITES must have a worktree, so a repository it cannot be
      // cut from is a hard failure. A job that is merely writable-by-accident
      // (mcp on codex) is isolated where possible and proceeds where not —
      // refusing it would break every mcp-query run outside a git checkout to
      // guard a hazard that only exists inside one.
      const tool = toolFor(callerCwd)
      if (!worktree && tool) {
        // The PROJECT owns its worktrees. A bare `git worktree add` here would
        // produce a directory with no .env, no vendor and no database, in which
        // every test the worker runs is meaningless and green.
        worktree = createWithTool(tool, callerCwd, claim.id, opts.seed, opts.key, opts.base)
      } else if (!worktree && !writesJob && !repoRootOf(callerCwd)) {
        console.error(
          `orch: run ${claim.id} has a writable sandbox (mcp) but ${callerCwd} is not a ` +
          'git repository, so it cannot be isolated in a worktree.',
        )
      } else if (!worktree) {
        // INHERITED on a resume, and this is the point of the whole exercise:
        // the worker is mid-edit in that tree, and cutting a fresh one would
        // answer its question into an empty checkout and throw away everything
        // it had built.
        worktree = createWorktree(callerCwd, claim.id, opts.base)
      }
    }
    if (worktree) {
      db().query('UPDATE run SET cwd=?, worktree=?, branch=?, base_commit=? WHERE id=?')
        .run(worktree.path, worktree.path, worktree.branch, worktree.base, claim.id)
      cwd = worktree.path
    }
  } catch (e) {
    const why = errorTail(String((e as Error)?.message ?? e))
    db().query(
      // 'harness': setting a worktree up is orch's job, and failing at it says
      // nothing whatever about the agent that was about to be given it.
      `UPDATE run SET status='failed', error=?, failure_kind='harness', latency_ms=? WHERE id=?`,
    ).run(why, Date.now() - started, claim.id)
    throw Object.assign(new Error(`run ${claim.id} could not start: ${why}`), { runId: claim.id })
  }

  // Git normally writes new blobs into the common object database. Codex may
  // write only this worktree's metadata directory, so its objects live there
  // and read the repository's existing objects through a read-only alternate.
  const gitObjectEnvironment = name === 'codex' && writesJob && worktree
    ? prepareWorktreeObjects(worktree.path)
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
     * A registered project's agents get its toolchain; anywhere else does not.
     *
     * Resolved HERE, from the register, and never taken from a caller's flag —
     * a flag would let any invocation widen its own sandbox, and the whole
     * point of the boundary is that this is a property of the PROJECT rather
     * than of whoever typed the command. See ProjectSettings.agentSandbox for
     * why a registered repository is the line.
     */
    sandbox: ((): SandboxLevel => {
      const p = projectAt(callerCwd)
      return p ? (p.settings.agentSandbox ?? 'exec') : 'read-only'
    })(),
    // Staging writes the linked worktree's index outside its checkout. Grant
    // that one metadata directory, never the common .git directory around it.
    writableRoots: writesJob && worktree ? [worktreeGitDir(worktree.path)] : undefined,
    gitObjectEnvironment,
  }
  const argv = opts.resume
    ? a.resumeArgv!({ ...argvOpts, session: opts.resume.session })
    : a.argv(argvOpts)

  /**
   * The checkout's state BEFORE a read-only run, so an unexpected edit is
   * detectable afterwards. Cheap, and skipped entirely when the sandbox could
   * not have written anything.
   */
  const dirtyBefore = !writesJob && usingMcp && a.mcpImpliesWrite
    ? porcelain(callerCwd)
    : null

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
      env: childEnv(a, claim.id, runToken),
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
      const parsed = parseWorkerReplyWithCount(output)
      contract = parsed.reply
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
      failureKind = replyError.split('\n').some((line) => line.trim().toLowerCase() === 'cancelled') &&
        classify(replyError, exitCode, timedOut) === 'interrupted'
        ? 'interrupted'
        : 'other'
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
      error = errorTail(
        `the worker completed and wrote its reply, then the process was killed ` +
        `(exit ${exitCode}). Its work is in the worktree; resume or read the diff.`,
      )
      failureKind = 'interrupted'
    } else if (writesJob && !contract) {
      // A writing run whose reply cannot be parsed has not reported what it
      // did, and its diff may be anything at all. Recording it `ok` would put
      // an unverifiable change set into the record as a completed one.
      status = 'failed'
      error = errorTail(`reply did not match the worker contract:\n${output}`)
      failureKind = 'other'
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
    /**
     * Did a READ-ONLY run change the checkout it was pointed at?
     *
     * It should not have: nothing asked it to, and its job declares no write.
     * But codex's MCP mode carries a writable sandbox it did not request, so
     * the possibility exists and silence about it would be the worst answer.
     * Cheap to ask — one `git status --porcelain` against a tree we are not
     * managing — and only asked when the sandbox was actually writable.
     */
    if (!writesJob && usingMcp && a.mcpImpliesWrite) {
      const dirty = dirtiedTree(callerCwd, dirtyBefore)
      if (dirty) {
        console.error(
          `orch: run ${claim.id} was read-only but ${callerCwd} changed while it ran:\n${dirty}`,
        )
      }
    }

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
    }
  }

  // Quota and auth stop the agent working until a person acts. Nothing
  // downstream can route around that, so it is raised at the moment it happens
  // rather than waiting to be noticed in a log.
  if (failureKind && NEEDS_HUMAN.includes(failureKind)) {
    notify(
      NEEDS_HUMAN_TITLE[failureKind]?.(name) ?? `${name} needs attention`,
      `${opts.job} failed. Routing will avoid it until it succeeds again.`,
    )
  }

  if (status === 'failed') {
    throw Object.assign(new Error(`run ${claim.id} failed: ${error}`), { runId: claim.id })
  }
  return {
    id: claim.id, agent: name, reason, output, latencyMs: Date.now() - started, exitCode,
    vendorTokens, costUsd, outPath, worktree, changes, contract, status,
  }
}
