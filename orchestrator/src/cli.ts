import { DB_PATH, db, nowIso, sessionId, judgeability, pendingForSession, unscoredCount, weigh,
         DELIVERY, QUALITY, FIDELITY, type Delivery, type Quality, type Fidelity,
         reapStale, pidAlive, STALE_AFTER_MS, UNSCORED_WHERE, recordDuels, duelMatrices,
         parseRunIds, recordSessionSeen, SESSION_LIVE_MS,
         resolveRootFromLastTurn } from './db.ts'
import { JOBS, job } from './jobs.ts'
import { AGENTS, available, installed, ensureLocalHealth,
         unavailableReason, NEEDS_HEALTH, tryWake, wakeStatus,
         lastWakeAttempt, readStrictCodexSchema } from './agents.ts'
import { candidates, pick, scoreboard, MIN_SAMPLE } from './route.ts'
import { guide } from './guide.ts'
import { repoOf, preflight, preflightMcp, KEEP_RUN_FILES_DAYS, RUNS_DIR, runFilePaths, terminateRunProcesses,
         type DetachSpec } from './run.ts'
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { createHasPlaceholder, projectAt, projectByName, projects } from './projects.ts'
import { resolveBase, repoRootOf, removeBranch, unmergedBranch,
         checkoutHasUncommittedWork, callerDrift } from './worktree.ts'
import { classify, NOT_EVIDENCE, type FailureKind } from './failure.ts'
import { WORKER_PREAMBLE, READONLY_PREAMBLE, NO_REPO_PREAMBLE, contractConflicts } from './contract.ts'
import { collectResult, collectWait, resolveFailover, failoverSummary } from './collect.ts'
import { failureReason, outcomeOf, type OutcomeRow } from './outcome.ts'
import { validateCliArgs } from './args.ts'
import { completeReview, DISPOSITIONS, parseReviewOutput, recordReviews,
         reviewCalibration, triageFinding, type Disposition } from './review.ts'

/**
 * How long `orch do` watches a detached run before handing it back.
 *
 * Derived, not guessed: every agent's own timeout is held below STALE_AFTER_MS
 * (asserted in the suite), and the reaper sweeps anything older, so a run has
 * always reached a terminal state by then. The extra minute is for the reaper's
 * own poll to land.
 */
const FOLLOW_TIMEOUT_MS = STALE_AFTER_MS + 60_000

function parsedVersion(text: string): string | null {
  return text.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null
}

function versionBelow(actual: string, minimum: string): boolean {
  const a = actual.split('.').map(Number)
  const m = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== m[i]!) return a[i]! < m[i]!
  }
  return false
}

function cliVersion(bin: string): { display: string; parsed: string | null } {
  const p = Bun.spawnSync([bin, '--version'], { stdout: 'pipe', stderr: 'pipe' })
  const stdout = new TextDecoder().decode(p.stdout).trim()
  const stderr = new TextDecoder().decode(p.stderr).trim()
  const display = stdout || stderr || `exit ${p.exitCode}`
  return { display, parsed: parsedVersion(`${stdout}\n${stderr}`) }
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
  const writes = Boolean(JOBS[jobName]?.needs.writesRepo)
  return `orch score ${target} <none|partial|full> [wrong|mixed|right]`
    + (writes ? ' [drifted|partial|faithful]' : '')
    + ' --note "..."'
    + (parent ? `   # the whole conversation, not turn ${id}` : '')
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

/** A run id is a machine interface: callers feed it back to wait/result. */
function printRunId(id: number): void {
  process.stdout.write(`${id}\n`)
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
    '  Update the caller checkout before dispatch; repository runs from it will be refused.',
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
    reapStale()
    await new Promise((r) => setTimeout(r, 1000))
  }
}


const argv = process.argv.slice(2)
const cmd = argv[0]

// One invocation is one heartbeat. Keeping it at the process boundary avoids
// turning the many read helpers below into competing writers.
const readOnlyPortDryRun = cmd === 'port' && argv[1] === 'import' && argv.includes('--dry-run')
if (!readOnlyPortDryRun) recordSessionSeen()

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
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
function flags(name: string): string[] {
  const needle = `--${name}`
  return argv.flatMap((value, index) => value === needle ? [argv[index + 1]!] : [])
}
const has = (n: string) => argv.includes(`--${n}`)

/** Flags that consume the next argument. Anything else is a boolean switch. */
const VALUE_FLAGS = new Set(['--agent', '--file', '--schema', '--model', '--note', '--message',
                             '--id', '--job', '--limit', '--port', '--days', '--window', '--timeout', '--scorer',
                             '--seed', '--key', '--repo', '--base', '--avoid', '--distinct-from', '--label', '--lens', '--category',
                             '--better-than', '--n', '--scope', '--subject', '--title', '--cwd'])

type CleanupRow = {
  id: number; worktree: string; branch: string | null; base_commit: string | null
}

function keptBranchLine(branch: string, count: number, id: number): string {
  return `kept branch ${branch}: ${count} commit(s) reachable only from this branch — ` +
    `merge it, or orch discard ${id} --force to delete it`
}

const KEPT_ROW_LIMIT = 10

function orphanKeepReason(detail: string): string {
  return /^has commits not reachable from /.test(detail)
    ? 'holds commits not on trunk'
    : detail
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
    const older = flag('older-than')
    if (older !== undefined) parts.push(`--older-than ${older}`)
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
  return repoRootOf(row.worktree ?? '') ?? repoRootOf(row.cwd ?? '')
    ?? (registered ? repoRootOf(registered) : null)
    ?? (builtInRoot ? repoRootOf(builtInRoot) : null) ?? repoRootOf(process.cwd())
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
 * So the tree goes only when nothing else still points at it. This run's
 * pointer is always cleared either way: the row is done with it, whoever
 * else is not. The caller supplies which statuses count as live: `discard`
 * keeps its rule, `abandon` also treats a blocked run as live.
 *
 * The repo root is resolved from the worktree when it still exists, and
 * from HERE when it does not — `repoRootOf` on a deleted directory can
 * answer nothing, and the prune still needs somewhere to run. The pointer is
 * cleared ONLY if the tree actually went: clearing it after a failed removal
 * orphans the directory, still on disk, no longer named by any run, and
 * nothing left that knows to try again.
 */
async function discardWorktree(
  row: CleanupRow, liveStatuses: string[], verb: 'discarded' | 'abandoned',
  force = false,
): Promise<void> {
  const placeholders = liveStatuses.map(() => '?').join(',')
  const sharers = db().query(
    `SELECT id, status FROM run
      WHERE worktree = ? AND id <> ? AND status IN (${placeholders})`,
  ).all(row.worktree, row.id, ...liveStatuses) as { id: number; status: string }[]
  if (sharers.length) {
    db().query('UPDATE run SET worktree = NULL WHERE id = ?').run(row.id)
    if (verb === 'discarded') {
      console.log(
        `run ${row.id} no longer points at ${row.worktree}, but the directory stays:\n` +
        sharers.map((r) => `  run ${r.id} is ${r.status} in it`).join('\n'),
      )
    } else {
      console.log(`worktree ${row.worktree} left because run ${sharers[0]!.id} is using it`)
      for (const r of sharers.slice(1)) {
        console.log(`worktree ${row.worktree} also left because run ${r.id} is using it`)
      }
    }
    return
  }

  const { removeFor, repoRootOf, unmergedBranch, restoreBranch } = await import('./worktree.ts')
  const repoRoot = repoRootOf(row.worktree) ?? projectAt(row.worktree)?.path ??
    repoRootOf(process.cwd()) ?? process.cwd()
  let protectedBranch: ReturnType<typeof unmergedBranch> = null
  if (!force && row.branch) {
    protectedBranch = unmergedBranch(repoRoot, row.branch, row.base_commit)
  }
  const r = removeFor({
    path: row.worktree,
    branch: row.branch ?? `orch/${row.id}`,
    base: '',
    repoRoot,
  }, repoRoot, force)
  if (protectedBranch && row.branch) restoreBranch(repoRoot, row.branch, protectedBranch.tip)
  if (!r.removed) throw new Error(r.detail)
  db().query('UPDATE run SET worktree = NULL, branch_kept = ? WHERE id = ?')
    .run(protectedBranch ? row.branch : null, row.id)
  console.log(`${verb} run ${row.id}'s worktree`)
  if (r.output) console.log(r.output)
  if (protectedBranch && row.branch) {
    console.log(keptBranchLine(row.branch, protectedBranch.count, row.id))
  }
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
    : preflight(jobName, cwd, spec.seed, spec.key, spec.base, false, false, spec.lens)
  if (!spec.resume) {
    // Who will run is knowable here, and a proven-failed grok attach must not
    // leave a placeholder for the child to fail. Resume keeps the agent that
    // already started; it is not a new dispatch.
    preflightMcp({
      mcp: spec.mcp, cwd, job: jobName, prompt,
      agent: spec.agent, avoid: spec.avoid,
      distinctModels: spec.distinctModels, model: spec.model,
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
  const { id } = db().query(
    `INSERT INTO run (started_at, agent, job, repo, cwd, prompt_sha, prompt_bytes,
                      prompt_head, label, status, session_id, probe)
     VALUES (?, '(pending)', ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?) RETURNING id`,
  ).get(
    nowIso(), jobName, spec.repo ?? repoOf(cwd), cwd,
    createHash('sha256').update(prompt).digest('hex').slice(0, 16),
    prompt.length, prompt.slice(0, 200).replace(/\s+/g, ' '), spec.label ?? null,
    sessionId(), spec.probe ? 1 : 0,
  ) as { id: number }
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

/** Resume a root run through the one path shared by `continue` and writing retries. */
async function continueRun(id: number, message?: string): Promise<{ childId: number; job: string }> {
  const row = db().query(
    'SELECT id, job, session_id, parent_run_id, status FROM run WHERE id = ?',
  ).get(id) as
    { id: number; job: string; session_id: string | null; parent_run_id: number | null
      status: string } | null
  if (!row) throw new Error(`no run ${id}`)
  if (row.parent_run_id) {
    throw new Error(`run ${id} is a turn of run ${row.parent_run_id}; continue that one`)
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
    `SELECT id, agent, vendor_session, turn, cwd, worktree, branch, base_commit
       FROM run WHERE id = ? OR parent_run_id = ?
      ORDER BY turn DESC LIMIT 1`,
  ).get(id, id) as {
    id: number; agent: string; vendor_session: string | null; turn: number
    cwd: string | null; worktree: string | null; branch: string | null; base_commit: string | null
  }
  const sessionFrom = latest.vendor_session
    ? latest
    : db().query(
        `SELECT id, vendor_session, turn
           FROM run WHERE (id = ? OR parent_run_id = ?) AND vendor_session IS NOT NULL
          ORDER BY turn DESC LIMIT 1`,
      ).get(id, id) as { id: number; vendor_session: string; turn: number } | null
  if (!sessionFrom?.vendor_session) {
    throw new Error(`run ${id} recorded no session id, so ${latest.agent} cannot be resumed`)
  }
  if (!latest.vendor_session) {
    console.error(
      `run ${id}: newest turn ${latest.id} recorded no session id; ` +
      `resuming with the session from run ${sessionFrom.id} (turn ${sessionFrom.turn})`,
    )
  }
  const prompt = message
    ?? 'Continue from where you stopped and finish the spec. If you reached a ' +
       'decision that is not yours, stop and ask as before.'
  const launch = db().query(
    `SELECT launch_cwd, launch_seed, launch_key, launch_base, no_failover
       FROM run WHERE id=?`,
  ).get(id) as {
    launch_cwd: string | null; launch_seed: string | null; launch_key: string | null
    launch_base: string | null; no_failover: number
  }
  const childId = await detach(row.job, prompt, {
    cwd: latest.cwd ?? process.cwd(),
    seed: launch.launch_seed ?? undefined,
    key: launch.launch_key ?? undefined,
    base: launch.launch_base ?? undefined,
    noFailover: !!launch.no_failover,
    resume: {
      parent: id, agent: latest.agent, session: sessionFrom.vendor_session,
      turn: latest.turn + 1, sessionId: row.session_id,
      worktree: latest.worktree
        ? {
            path: latest.worktree,
            branch: latest.branch ?? `orch/${id}`,
            base: latest.base_commit ?? '',
            repoRoot: (await import('./worktree.ts')).repoRootOf(latest.worktree) ?? process.cwd(),
          }
        : null,
    },
  })
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

function baseHelp(description: string): string {
  const create = projectAt(process.cwd())?.settings.worktree?.create
  return create && !createHasPlaceholder(create, 'base')
    ? `${description} (unsupported for this project's create arguments: no {base})`
    : description
}

function usage(): never {
  console.log(`orch — delegate work to external agents and score them per job type

  orch do <job> [prompt]        run a job; prompt from argv, --file, or stdin
      --detach                  print a run id and return at once (the default); collect with
                                'orch wait' and 'orch result'. This is how a
                                fan-out is done: N detaches, one wait.
      --porcelain               print exactly the run id, for machine callers
      --agent <name>            force an agent instead of routing
      --avoid <agent>[,...]     route to any other agent when possible
      --distinct-from <id>[,...] avoid models used by earlier fan-out runs
      --base <ref>              ${baseHelp('base an implement worktree on this git ref')}
      --carry                   carry this checkout's uncommitted work into the worker (off by default)
      --file <path>             read the prompt from a file
      --schema <path>           bind JSON schema (Codex normalizes it to OpenAI strict mode)
      --mcp                     allow MCP tool calls
      --model <name>            override the agent's model
      --label <text>            name this run in listings and pending reminders
      --lens <stable-id>        required identity for findings-producing review jobs
      --quiet                   print only the reply
      --probe                   a calibration run: recorded, but not routing evidence
      --seed <spec>             choose a required project-specific database seed spec
      --key <KEY-123>           supply a required branch ticket key
      --repo <name>             attribute work launched outside a registered project
      --follow                  block and watch the run instead of returning its id
      --no-failover             do not retry quota/auth deaths on another agent

  orch issue <TASK-KEY>         reproduce, diagnose, fix and independently verify one filed issue

  orch contract <job>          print the preamble prepended to that job's prompt

  orch score <run-id> <none|partial|full> [wrong|mixed|right] [--note "..."]
      delivery first (did an answer arrive), then quality (was it right).
      'none' takes no quality — there was nothing to judge.
      only the session that MADE a run may score it; --force overrides.
      --better-than <id>[,<id>] record this run winning a pairwise comparison
      --scorer <who>            a person judged it from a UI: records who, and
                                is the gate's one named exception
      --void                    retain the run and output, but exclude it from routing evidence
  orch recalibrate [--n 12]    re-score old outputs blind and measure agreement
      --scorer <who>            use the same scorer identity as orch score
      --force                   sample any scorer's old scores
  orch wait <run-id>...         block until those runs finish (--timeout SECONDS, default 1800)
  orch result <run-id>          print a finished run's output; exit 2 if still running
  orch retry <run-id>           re-send a run's exact prompt to the SAME agent
      --agent <name>            ... or to a different one, deliberately
  orch review record <run-id>... record completed lens outputs before triage
  orch review triage <review-id> <finding> <accepted|modified|rejected|skipped>
      --category <name>         required rejection category for rejected findings
  orch review complete <review-id> mark a fully triaged review complete
  orch review calibration <lens> <agent> <model> [--json]  (--json: one JSON document)
  orch pending                  runs YOU made that are still unscored (exit 1 if any)
  orch runs [--id ID]... [--job X] [--agent Y] [--limit N] [--unscored] [--since ISO] [--json]
      --id queries exactly those run ids; repeat it for a union of ids
      --id and --since cannot be combined
      --json                    print one JSON object per line, with cwd and session id: the interface hub reads
  orch stats [--job X]          success rate per agent per job
  orch guide [--job X]          what to use for what: best, quickest, and what is still a guess
  orch spawns [--limit N]       what the subagent gate allowed and denied, and why
  orch pick <job>               show which agent would be chosen, and why
      --agent <name>            preview an explicit agent pin
      --avoid <agent>[,...]     preview routing away from these agents
      --distinct-from <id>[,...] preview routing away from models used by these runs
  orch state [--days N]         the dashboard payload as JSON (what hub renders)
      the dashboard itself is 'hub serve' - this concern routes and scores
  orch run <run-id>             one run's detail as JSON, prompt and output included
  orch search <query>           consult score notes, rulings, review findings, and saved outputs
      --limit <n>               compact results to return (default 20)
      --full                    include the complete matched records after choosing them
      --json                    print one JSON document, including unavailable output count
  orch metric [collect]         Claude tokens per shipped task (the ratio this exists to move)
  orch blockers [--days N] [--json]
      what stopped agents verifying their work, ordered by recurrence
      --json                    print one JSON document (the published surface; never orch.db)
  orch monitor [--backstop]     detect, record, report, and safely reconcile machine state
      --history [--limit N]     query recorded invocations and condition ages
      --json                    emit the report as JSON; silent on a clean live pass
  orch inbox [--all] [--json]   design questions a worker is waiting on you to rule on
      --json                    print one JSON document
  orch tell <id> ["<message>"]   queue non-authoritative context for a running worker
      --file <path>             read a long message from a file
  orch setup-ask                register the live ask channel with codex and grok
  orch answer <id> ["<ruling>"] rule from argv, --file, or stdin; resume detached
      --file <path>             read the ruling from a file
      --follow                  watch the resumed turn here instead
  orch continue <id> ["<what next>"]
      carry on a chain with no open question - one that was interrupted, or
      one you want to add to without paying for its context again
      detaches by default; --follow watches the resumed turn here
      several questions: orch answer <id> --q<qid> "<ruling>" --q<qid> "<ruling>"
  orch diff <id>                inspect a run's worktree diff (review diffs are scratch)
  orch land <branch|run-id>     gate and fast-forward one explicit branch into configured trunk
      --message TEXT            amend the branch tip's message, then gate that commit
      --file PATH               same, reading the message from a file
      --status                  show this project's landing lock without taking it
  orch stop <id>                terminate a running run and reclaim its worktree
  orch discard <id>             delete that run's worktree (the row stays)
      --force                   also delete a protected branch; bypass a refusing project tool
                                only for a tree marked as created by orch
  orch abandon <id> [--note "..."] [--force] retire an asking run and clean up its worktree
  orch sweep [--older-than N] [--force] [--dry-run]
      reclaim finished runs' worktrees AND the databases behind them; keeps
      anything unscored, because its diff is the evidence you would judge from.
      more than ten kept rows are summarised by reason; --dry-run lists every row
  orch reclassify-failures [--dry-run]
      reclassify stored unclassified vendor quota/auth failures from their error text;
      prints every matched row and before/after counts before writing
  orch doctor                   agents, local endpoint, routing at a glance
  orch project [list] [--json]  the register: where work lives, and what it is built from
      --json                    print one JSON document (the published surface; never orch.db)
      add <path> [--name X] [--stack Y] [--no-canon] [--json]  (--json: one JSON document)
      set <name> [--stack X] [--path P] [--canon|--no-canon] [--settings JSON] [--json]  (--json: one JSON document)
          JSON null deletes that settings key; objects merge deeply
          --allow-incomplete    save a create command missing branch or seed configuration
      remove <name>
  orch doc list [--scope S] [--subject X] [--json]  (--json: one JSON document)
      show <slug> --scope S [--subject X] [--json]  (--json: one JSON document)
      set <slug> --scope S [--subject X] --title T (--file F | body on stdin) [--json]  (--json: one JSON document)
      consume <slug> --scope S [--subject X] [--json]  (--json: one JSON document)
      rm <slug> --scope S [--subject X] [--json]  (--json: one JSON document)
      subjects [--json]  (--json: one JSON document)
      export <dir> | import <dir> | brief [--cwd P] | resumes [--cwd P]
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
  orch jobs                     list job types
  orch agents                   list agents and availability
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

  --agent <name>   force an agent instead of using the router
  --avoid <name,...> exclude agents while routing, unless none remain
  --distinct-from <id,...> exclude models used by earlier runs, unless none remain
  --base <ref>     ${baseHelp('base an implement worktree on this verified git ref')}
  --carry          carry this checkout's uncommitted work into the worker (off by default)
  --schema <path>  require JSON schema; Codex normalizes it to OpenAI strict mode
  --mcp            allow MCP tool calls
  --model <name>   override the selected agent's model
  --label <text>   name this run in listings and pending reminders
  --lens <id>      stable identity required by findings-producing review jobs
  --probe          record a calibration run that does not affect routing
  --seed <spec>    choose the project-specific database seed required by some projects
  --key <KEY-123>  supply the ticket key required by some branch templates
  --repo <name>    attribute a run launched outside a registered project
  --file <path>    read the prompt from a file instead of argv or stdin
  --detach         print the run id and return immediately (the default)
  --porcelain      print exactly the run id, for machine callers
  --follow         block and watch the run instead of returning its id
  --no-failover    do not retry quota/auth deaths on another agent
  --quiet          print only the reply or run id
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

async function readPrompt(): Promise<string> {
  const f = flag('file')
  if (f) return readFileSync(f, 'utf8')
  // A boolean switch does not consume the next argument, so only skip the one
  // after a flag that actually takes a value — otherwise `--quiet <prompt>`
  // silently discards the prompt.
  const rest = argv.slice(2)
  const positional = rest.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(rest[i - 1] ?? ''))
  if (positional.length) return positional.join(' ')
  if (!process.stdin.isTTY) return await Bun.stdin.text()
  throw new Error('no prompt: pass it as an argument, via --file, or on stdin')
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
if (NEEDS_HEALTH.has(cmd ?? '')) await ensureLocalHealth()

switch (cmd) {
  case 'land': {
    const { land, landingStatus, resolveLandingBranch } = await import('./landing.ts')
    if (has('status')) {
      console.log(landingStatus(process.cwd()))
      break
    }
    const value = argv[1]
    if (!value || value.startsWith('--')) {
      throw new Error('orch land <branch|run-id> [--message TEXT] [--file PATH] | orch land --status')
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
    land(process.cwd(), target.branch, message === undefined ? {} : { message })
    break
  }

  case 'contract': {
    const jobName = argv[1]
    if (!jobName) throw new Error('orch contract <job>')
    const selected = job(jobName)
    process.stdout.write((selected.needs.writesRepo
      ? WORKER_PREAMBLE
      : selected.needs.readsRepo ? READONLY_PREAMBLE : NO_REPO_PREAMBLE) + '\n')
    break
  }

  case 'doc': {
    const { listDocs, getDoc, setDoc, consumeDoc, removeDoc, exportDocs, importDocs, brief, docSubjects,
            listOpenResumes } =
      await import('./docs.ts')
    const sub = argv[1] ?? 'list'
    const scope = flag('scope')
    const subject = flag('subject') ?? null
    if (sub === 'list') {
      const rows = listDocs({ scope, ...(has('subject') ? { subject } : {}) })
      if (has('json')) { console.log(JSON.stringify(rows)); break }
      if (!rows.length) break
      console.log('scope    subject          slug                     title                    bytes  updated')
      for (const d of rows) {
        console.log(
          `${d.scope.padEnd(8)} ${(d.subject ?? '-').padEnd(16)} ${d.slug.padEnd(24)} ` +
          `${d.title.padEnd(24)} ${String(Buffer.byteLength(d.body)).padStart(6)}  ${d.updated_at}`,
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
      if (!slug || !scope || title === undefined) {
        throw new Error('orch doc set <slug> --scope S [--subject X] --title T (--file F | body on stdin)')
      }
      const body = flag('file') ? readFileSync(flag('file')!, 'utf8')
        : !process.stdin.isTTY ? await Bun.stdin.text()
        : (() => { throw new Error('no body: pass --file F or pipe markdown on stdin') })()
      const doc = setDoc({ scope, subject, slug, title, body })
      console.log(has('json') ? JSON.stringify(doc) : `set ${doc.scope}/${doc.subject ?? '_'}/${doc.slug}`)
      break
    }
    if (sub === 'consume') {
      const slug = argv[2]
      if (!slug || !scope) throw new Error('orch doc consume <slug> --scope S [--subject X]')
      const result = consumeDoc(scope, subject, slug)
      if (has('json')) { console.log(JSON.stringify(result)); break }
      console.log(result.already_consumed
        ? `already consumed ${result.scope}/${result.subject ?? '_'}/${result.slug}`
        : `consumed ${result.scope}/${result.subject ?? '_'}/${result.slug}`)
      break
    }
    if (sub === 'rm') {
      const slug = argv[2]
      if (!slug || !scope) throw new Error('orch doc rm <slug> --scope S [--subject X]')
      const removed = removeDoc(scope, subject, slug)
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
      const count = sub === 'export' ? exportDocs(dir) : importDocs(dir)
      console.log(`${sub === 'export' ? 'exported' : 'imported'} ${count} docs`)
      break
    }
    if (sub === 'brief') {
      process.stdout.write(brief(flag('cwd') ?? process.cwd()))
      break
    }
    if (sub === 'resumes') {
      const rows = listOpenResumes(flag('cwd') ?? process.cwd())
      for (const r of rows) {
        console.log(`${r.slug.padEnd(24)} ${r.title.padEnd(24)} ${r.age}`)
      }
      break
    }
    throw new Error(`unknown: orch doc ${sub}. Try list | show | set | consume | rm | subjects | export | import | brief | resumes`)
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
      const printPlan = () => {
        const visible = visiblePlan()
        const uncoveredSpans = visible.uncoveredSpans
        if (has('json')) { console.log(JSON.stringify(visible, null, 2)); return }
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
        printPlan()
        if (plan.refusals.length) process.exitCode = 1
        break
      }
      try {
        applyImport(plan, { replace: has('replace') })
      } catch (error) {
        if (!(error instanceof ImportRefusalError)) throw error
        plan.refusals.push(...error.refusals.filter((refusal) => !plan.refusals.includes(refusal)))
        printPlan()
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

  case 'issue': {
    const key = argv[1]
    if (!key) throw new Error('orch issue <TASK-KEY>')
    const { workIssue } = await import('./issue.ts')
    await workIssue(key.toUpperCase())
    break
  }

  case 'do': {
    const jobName = argv[1]
    if (!jobName) usage()
    if (jobName === '--help' || jobName === '-h') doUsage()
    const porcelain = has('porcelain')
    if (porcelain && has('follow')) {
      throw new Error('--porcelain cannot be combined with --follow')
    }
    const requested = job(jobName)
    const explicitRepo = flag('repo')
    if (explicitRepo && !projectByName(explicitRepo)) {
      throw new Error(`unknown repo "${explicitRepo}". Registered: ${projectNames()}`)
    }
    // Project-required inputs are knowable before the prompt is read. Checking
    // them afterwards made a missing key pay for stdin and run setup first.
    const base = flag('base')
    if (base) {
      if (jobName !== 'implement') throw new Error('--base is only valid for the implement job')
      resolveBase(process.cwd(), base)
    }
    const seed = preflight(
      jobName, process.cwd(), flag('seed'), flag('key'), base, false, false, flag('lens'),
    )
    if (requested.needs.readsRepo) warnCallerDrift(process.cwd(), base)
    const schema = flag('schema')
    // An unpinned run may route to Codex, so its schema has to be suitable
    // before detach() claims a row. An explicitly pinned non-Codex agent keeps
    // its own schema dialect and reads the caller's original file unchanged.
    if (schema && (!flag('agent') || flag('agent') === 'codex')) readStrictCodexSchema(schema)
    const { avoid, distinctModels } = await routeConstraints(flag('agent'))
    if (!porcelain && !explicitRepo && !projectAt(process.cwd())) {
      console.error(
        `! this run will not be attributed to any project; use --repo <name> ` +
        `(registered: ${projectNames()})`,
      )
    }
    if (!porcelain && !has('carry') && requested.needs.readsRepo &&
        checkoutHasUncommittedWork(process.cwd())) {
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
        agent: flag('agent'), schema, label: flag('label'), lens: flag('lens'),
        mcp: has('mcp'), model: flag('model'), probe: has('probe'), seed, key: flag('key'),
        repo: explicitRepo, base, avoid, distinctModels,
        noFailover: has('no-failover'), carry: has('carry'),
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
      agent: flag('agent'), schema, label: flag('label'), lens: flag('lens'),
      mcp: has('mcp'), model: flag('model'), probe: has('probe'), seed, key: flag('key'),
      repo: explicitRepo, base, avoid, distinctModels,
      noFailover: has('no-failover'), carry: has('carry'),
    })
    warnImplementContractConflicts(conflicts, id)

    await follow(id, has('quiet'))
    break
  }

  case 'review': {
    const sub = argv[1]
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
      console.log(recordReviews(entries))
      break
    }
    if (sub === 'triage') {
      const reviewId = Number(argv[2])
      const finding = Number(argv[3])
      const disposition = argv[4] as Disposition
      if (!reviewId || !finding || !DISPOSITIONS.includes(disposition)) {
        throw new Error('orch review triage <review-id> <finding> <accepted|modified|rejected|skipped> [--category X]')
      }
      triageFinding(reviewId, finding, disposition, flag('category'))
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
    if (sub === 'calibration') {
      const lens = argv[2]
      const agent = argv[3]
      const model = argv[4]
      if (!lens || !agent || !model) throw new Error('orch review calibration <lens> <agent> <model> [--json]')
      const calibration = reviewCalibration(lens, agent, model)
      console.log(has('json') ? JSON.stringify(calibration) :
        calibration.precision === null
          ? `${lens}/${agent}: insufficient evidence (${calibration.triaged} triaged)`
          : `${lens}/${agent}: ${calibration.precision.toFixed(2)} (${calibration.hits}/${calibration.triaged}, ${calibration.basis})`)
      break
    }
    throw new Error(`unknown: orch review${sub ? ` ${sub}` : ''}. Try record | triage | complete | calibration`)
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
    const d = runDetail(id)
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
    const f = flag('file')
    const positional = argv.slice(2).filter((a, i, all) =>
      !a.startsWith('--') && all[i - 1] !== '--file')
    if (f && positional.length) {
      throw new Error('pass the message either positionally or with --file, not both')
    }
    const body = f ? readFileSync(f, 'utf8')
      : positional.length ? positional.join(' ')
      : !process.stdin.isTTY ? await Bun.stdin.text()
      : (() => { throw new Error('no message: pass it as an argument, via --file, or on stdin') })()
    const { tellRun } = await import('./mailbox.ts')
    const message = tellRun(id, body)
    console.log(
      `queued message ${message.id} for run ${message.root_run_id} ` +
      `(turn ${message.run_id}); it has not been read`,
    )
    break
  }

  case 'result': {
    collectResult(db(), argv, (jobName) => Boolean(JOBS[jobName]?.needs.writesRepo))
    break
  }

  case 'wait': {
    await collectWait(db(), argv, reapStale)
    break
  }

  case 'retry': {
    const id = Number(argv[1])
    if (!id) usage()
    const row = db().query(
      'SELECT id, agent, job, cwd, prompt_path, probe, status, failure_kind, mcp, schema_path, model, lens FROM run WHERE id = ?',
    ).get(id) as {
      id: number; agent: string; job: string; cwd: string | null
      prompt_path: string | null; probe: number; status: string; failure_kind: string | null
      mcp: number | null; schema_path: string | null; model: string | null; lens: string | null
    } | null
    if (!row) throw new Error(`no run ${id}`)
    // A writing job already has a worktree and a vendor session. Retry would
    // wrap the prompt again and cut a fresh tree beside the one holding the
    // partial edit. Continue the same conversation in the same tree instead.
    if (job(row.job).needs.writesRepo) {
      const requested = flag('agent')
      if (requested && requested !== row.agent) {
        throw new Error(
          `a writing run continues on its own agent (${row.agent}); to start over on ${requested}: ` +
          `orch do ${row.job} --agent ${requested} ...`,
        )
      }
      const resumed = await continueRun(id)
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
    console.error(
      `— retrying run ${id} (${row.agent}/${row.job}` +
        (row.failure_kind ? `, ${row.failure_kind}` : '') + `) on ${agent}`,
    )
    // Detached and followed, exactly like `do`. A retry is usually started
    // BECAUSE the first attempt died; running it as a child of this process
    // would leave it dying the same way.
    const newId = await detach(row.job, readFileSync(row.prompt_path, 'utf8'), {
      agent,
      schema: row.schema_path ?? undefined,
      mcp: !!row.mcp,
      model: row.model ?? undefined,
      lens: row.lens ?? undefined,
      probe: !!row.probe, retryOf: id, cwd: row.cwd ?? undefined,
    })
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
   * Defaults to this session's own runs, for the same reason scoring does: the
   * architect who wrote the spec is the one who can rule on it. `--all` is
   * there because a question can outlive the session that provoked it.
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
            worktreeWarnings, validateProjectSettings } = await import('./projects.ts')
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
        console.log(JSON.stringify(all))
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
      const candidate = { id: 0, name, path, stack, canon: !has('no-canon'), settings: {} }
      const incomplete = worktreeWarnings(candidate).filter((w) =>
        w.startsWith('has a create command but no branch template') ||
        w.startsWith('has a create command with a {seed} placeholder but no seeds list'))
      if (incomplete.length && !has('allow-incomplete')) throw new Error(incomplete.join('\n'))
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
      const candidate = {
        id: p.id,
        name,
        path: flag('path') ?? p.path,
        stack: flag('stack') ?? p.stack,
        canon: has('no-canon') ? false : has('canon') ? true : p.canon,
        settings,
      }
      const malformed = validateProjectSettings(candidate.settings)
      if (malformed.length) throw new Error(malformed.join('\n'))
      const incomplete = worktreeWarnings(candidate).filter((w) =>
        w.startsWith('has a create command but no branch template') ||
        w.startsWith('has a create command with a {seed} placeholder but no seeds list'))
      if (incomplete.length && !has('allow-incomplete')) throw new Error(incomplete.join('\n'))
      upsertProject(candidate)
      if (has('json')) {
        console.log(JSON.stringify(projectByName(name)))
        break
      }
      console.log(`updated ${name}`)
      for (const w of worktreeWarnings(projectByName(name)!)) {
        console.log(`${' '.repeat(14)} ! ${w}`)
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
    const { monitor, monitorHistory } = await import('./monitor.ts')
    if (has('history')) {
      const rows = monitorHistory(Number(flag('limit') ?? 20))
      if (has('json')) console.log(JSON.stringify(rows))
      else for (const row of rows as any[]) {
        console.log(`monitor ${row.id}  ${row.started_at}  ${row.trigger}  ${row.findings} found, ${row.errors} errors`)
        for (const condition of row.conditions) {
          const old = condition.age_ms == null ? 'age unknown' : `${Math.round(condition.age_ms / 60_000)}m old`
          console.log(`  ${condition.kind}  ${condition.subject}  ${old}  ${condition.action}`)
        }
      }
      break
    }
    const result = await monitor(has('backstop') ? 'backstop' : 'invoked')
    if (has('json')) console.log(JSON.stringify(result))
    else if (result.conditions.length || result.errors.length) {
      console.log(`monitor ${result.id}: ${result.conditions.length} condition(s), ${result.errors.length} observation error(s)`)
      for (const condition of result.conditions) {
        const old = condition.ageMs == null ? 'age unknown' : `${Math.round(condition.ageMs / 60_000)}m old`
        console.log(`  ${condition.kind}  ${condition.subject}  ${old}\n    ${condition.detail}\n    ${condition.action}${condition.issueKey ? `; ${condition.issueKey}` : ''}`)
      }
      for (const error of result.errors) console.error(`  observation failed: ${error}`)
    }
    // Branchable by hooks and automation: 0 clean, 2 conditions, 1 incomplete observation.
    if (result.errors.length) process.exitCode = 1
    else if (result.conditions.length) process.exitCode = 2
    break
  }

  case 'inbox': {
    const sid = sessionId()
    const mine = !has('all')
    const cutoff = new Date(Date.now() - SESSION_LIVE_MS).toISOString()
    const hasSessionSeen = Boolean(db().query(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_seen'`,
    ).get())
    const seenJoin = hasSessionSeen
      ? 'LEFT JOIN session_seen seen ON seen.session_id = r.session_id'
      : ''
    const sessionLive = hasSessionSeen
      ? 'CASE WHEN r.session_id IS NOT NULL AND seen.last_seen >= ? THEN 1 ELSE 0 END'
      : '0'
    const allRows = db().query(
      `SELECT q.id, q.run_id, q.asked_at, q.question, q.options, q.recommendation, q.why,
              r.agent, r.job, r.repo, r.status, r.session_id,
              COALESCE(r.parent_run_id, r.id) root_id,
              ${sessionLive} session_live
         FROM question q JOIN run r ON r.id = q.run_id
         ${seenJoin}
        WHERE q.answered_at IS NULL
        ORDER BY q.run_id, q.id`,
    ).all(...(hasSessionSeen ? [cutoff] : [])) as {
      id: number; run_id: number; asked_at: string; question: string; options: string | null
      recommendation: string | null; why: string | null
      agent: string; job: string; repo: string | null; status: string; session_id: string | null
      root_id: number; session_live: number
    }[]
    const rows = mine ? allRows.filter((q) => sid !== null && q.session_id === sid) : allRows
    const orphaned = mine
      ? allRows.filter((q) => (sid === null || q.session_id !== sid) && !q.session_live)
      : []

    if (has('json')) {
      console.log(JSON.stringify([...rows, ...orphaned].map((q) => ({
        question_id: q.id,
        run_id: q.run_id,
        answer_id: q.root_id,
        job: q.job,
        agent: q.agent,
        repo: q.repo,
        asked_at: q.asked_at,
        session_live: Boolean(q.session_live),
        question: q.question,
        options: q.options ? JSON.parse(q.options) as string[] : [],
        recommendation: q.recommendation,
        why: q.why,
      }))))
      break
    }

    const recoverable = db().query(
      `SELECT root.id, root.agent, root.job, root.repo
         FROM run root
        WHERE root.parent_run_id IS NULL AND root.status = 'asking'
          ${mine ? 'AND root.session_id = ?' : ''}
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
    ).all(...(mine ? [sid] : [])) as {
      id: number; agent: string; job: string; repo: string | null
    }[]

    if (!rows.length && !recoverable.length && !orphaned.length) {
      console.log(mine ? 'no questions waiting on you' : 'no open questions')
      break
    }
    let lastRun = -1
    let lastRoot = -1
    for (const q of rows) {
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
    }
    if (rows.length) {
      console.log(
        `\nrule on them:  orch answer ${lastRoot} "<ruling>"    (one per question, in order)` +
        `\n               orch answer ${lastRoot} --q<id> "<ruling>"`,
      )
    }
    for (const r of recoverable) {
      console.log(
        `\nrun ${r.id} · ${r.agent}/${r.job}${r.repo ? ` · ${r.repo}` : ''} · ` +
        `asking, but no ruling is open — recoverable: orch continue ${r.id}`,
      )
    }
    if (orphaned.length) {
      console.log('\nwaiting on a ruling that anyone may give:')
      for (const q of orphaned) {
        console.log(
          `\n  [q${q.id}] run ${q.run_id} · answer ${q.root_id} · ${q.job} · ${q.agent}` +
          `${q.repo ? ` · ${q.repo}` : ''} · waiting ${dur(Date.now() - Date.parse(q.asked_at))}`,
        )
        console.log(`        ${q.question}`)
        if (q.why) console.log(`        why: ${q.why}`)
        const opts = q.options ? (JSON.parse(q.options) as string[]) : []
        for (const o of opts) console.log(`        - ${o}`)
        if (q.recommendation) console.log(`        recommendation: ${q.recommendation}`)
        console.log(`        orch answer ${q.root_id} --q${q.id} "<ruling>"`)
      }
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
    const requestedId = Number(argv[1])
    if (!requestedId) usage()
    const row = db().query(
      `SELECT root.id, root.agent, root.job, root.cwd, root.worktree, root.branch,
              root.base_commit, root.vendor_session, root.status, root.session_id,
              root.turn, root.parent_run_id
         FROM run requested
         JOIN run root ON root.id = COALESCE(requested.parent_run_id, requested.id)
        WHERE requested.id = ?`,
    ).get(requestedId) as {
      id: number; agent: string; job: string; cwd: string | null
      worktree: string | null; branch: string | null; base_commit: string | null
      vendor_session: string | null; status: string; session_id: string | null
      turn: number; parent_run_id: number | null
    } | null
    if (!row) throw new Error(`no run ${requestedId}`)
    const id = row.id

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
    const live = open.filter((q) => q.owner_status === 'running' && pidAlive(q.owner_pid))
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
    if (!ownersLive && !stopped.every((q) =>
      q.owner_status === 'asking' || q.owner_status === 'failed' || q.owner_status === 'stale')) {
      const states = stopped.map((q) => `q${q.id} (run ${q.owner_id}, ${q.owner_status})`).join(', ')
      throw new Error(`run ${id} has questions whose owners are not waiting or stopped: ${states}`)
    }
    if (!ownersLive && row.status !== 'asking') {
      throw new Error(`run ${id} is ${row.status}, not waiting on a ruling`)
    }

    // Two ways to rule: positionally when the order is obvious, or by question
    // id when there are several.
    const answers: { question: string; answer: string }[] = []
    const byId = open.map((q) => ({ q, given: flag(`q${q.id}`) })).filter((x) => x.given)
    if (byId.length) {
      for (const { q, given } of byId) answers.push({ question: q.question, answer: given! })
    } else {
      const positional = argv.slice(2).filter((x) => !x.startsWith('--'))
      if (flag('file') || (!positional.length && !process.stdin.isTTY)) {
        const given = await readPrompt()
        if (!given.trim()) throw new Error('empty ruling')
        answers.push({ question: open[0]!.question, answer: given })
      } else if (!positional.length) {
        throw new Error(
          `run ${id} is waiting on ${open.length} question(s). ` +
          `Rule with: orch answer ${id} --q${open[0]!.id} "<ruling>", ` +
          'or pass a ruling via --file or stdin.',
        )
      } else {
        open.forEach((q, i) => {
          const given = positional[i]
          if (given) answers.push({ question: q.question, answer: given })
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

    const now = nowIso()
    const upd = db().query(
      'UPDATE question SET answer=?, answered_at=?, answered_by=? WHERE id=?',
    )
    open.forEach((q, i) => upd.run(answers[i]!.answer, now, sessionId(), q.id))

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

    // The worker ended its turn, so the ruling has to restart it. Resume from
    // the LATEST turn's session rather than the root's: after turn two, the
    // root's session id is a conversation that has since moved on.
    const latest = db().query(
      `SELECT id, agent, vendor_session, turn, cwd, worktree, branch, base_commit
         FROM run WHERE id = ? OR parent_run_id = ?
        ORDER BY turn DESC LIMIT 1`,
    ).get(id, id) as {
      id: number; agent: string; vendor_session: string | null; turn: number
      cwd: string | null; worktree: string | null; branch: string | null; base_commit: string | null
    }
    if (!latest.vendor_session) {
      throw new Error(
        `ruled on ${answers.length} question(s); the rulings ARE recorded and were not lost.\n` +
        `Resume failed: run ${id} recorded no session id, so ${latest.agent} cannot be resumed.\n` +
        `Retry it with: orch continue ${id}`,
      )
    }

    const { rulingPrompt } = await import('./contract.ts')
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
        resume: {
          parent: id,
          agent: latest.agent,
          session: latest.vendor_session,
          turn: latest.turn + 1,
          sessionId: row.session_id,
          worktree: worktreePath
            ? {
                path: worktreePath,
                branch: latest.branch ?? row.branch ?? `orch/${id}`,
                base: latest.base_commit ?? row.base_commit ?? '',
                repoRoot: (await import('./worktree.ts')).repoRootOf(worktreePath) ?? process.cwd(),
              }
            : null,
        },
      })
    } catch (e) {
      throw new Error(
        `ruled on ${answers.length} question(s); the rulings ARE recorded and were not lost.\n` +
        `Resume failed: ${(e as Error).message}\n` +
        `Retry it with: orch continue ${id}`,
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
    const id = Number(argv[1])
    if (!id) usage()
    const message = argv.slice(2).find((x) => !x.startsWith('--'))
    const resumed = await continueRun(id, message)
    await reportContinuedRun(resumed.childId, resumed.job)
    break
  }

  case 'diff': {
    const id = Number(argv[1])
    if (!id) usage()
    const row = db().query(
      `SELECT id, worktree, branch, base_commit, parent_run_id, carry_happened,
              carry_base_commit, carry_tracked_paths, carry_untracked_paths
         FROM run WHERE id = ?`,
    ).get(id) as
      { id: number; worktree: string | null; branch: string | null
        base_commit: string | null; parent_run_id: number | null; carry_happened: number | null
        carry_base_commit: string | null; carry_tracked_paths: string | null
        carry_untracked_paths: string | null } | null
    if (!row) throw new Error(`no run ${id}`)
    if (!row.worktree) throw new Error(`run ${id} has no worktree`)
    if (!existsSync(row.worktree)) {
      throw new Error(`run ${id}'s worktree is gone (${row.worktree}) — discarded already?`)
    }
    if (!row.base_commit) throw new Error(`run ${id} recorded no base commit to diff against`)
    const { changesIn, repoRootOf } = await import('./worktree.ts')
    const c = changesIn({
      path: row.worktree,
      branch: row.branch ?? `orch/${id}`,
      base: row.base_commit,
      repoRoot: repoRootOf(row.worktree) ?? row.worktree,
    })
    const runKind = db().query('SELECT job FROM run WHERE id=?').get(id) as { job: string }
    if (!JOBS[runKind.job]?.needs.writesRepo) {
      console.error(
        `WARNING: run ${id} is a review/read job. Its findings are the product; this diff ` +
        `contains review input and scratch experiments and must not be landed.`,
      )
    }
    // A patch preamble is ignored by `git apply`, while keeping the base in the
    // stdout artefact even under --quiet or when stderr is not captured.
    process.stdout.write(`base: ${row.base_commit}\n`)
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
   * Nothing cleaned up automatically before this, and the reason was sound as
   * far as it went: a failed run's half-finished tree is the most readable
   * artefact this system produces, and removing it on failure would destroy the
   * evidence exactly where it is most useful. That argues for a DELAY, not for
   * never. A tree nobody has looked at in a day is not being read.
   *
   * So the rule is: terminal, old enough, and scored. Scored is the important
   * one — an unjudged run is one somebody still owes a verdict on, and its diff
   * is the evidence they would judge it from. `--force` skips that for a
   * backlog that is never going to be judged.
   */
  case 'sweep': {
    const days = Number(flag('older-than') ?? 1)
    if (!Number.isFinite(days) || days < 0) {
      throw new Error('--older-than must be a finite, non-negative number')
    }
    const dry = has('dry-run')
    const rows = db().query(
      `SELECT r.id, r.worktree, r.branch, r.status, r.job,
              (julianday('now') - julianday(r.started_at)) AS age_days,
              s.delivery IS NOT NULL AS scored
         FROM run r LEFT JOIN score s ON s.run_id = r.id
        WHERE r.worktree IS NOT NULL AND r.status IN ('ok','failed','stale')
        ORDER BY r.id`,
    ).all() as {
      id: number; worktree: string; branch: string | null; status: string
      job: string; age_days: number; scored: number
    }[]

    const { removeFor, sweepWithTool, repoRootOf, orphanSafety,
            isOrchWorktree, ORCH_RUN_MARKER } =
      await import('./worktree.ts')
    const { projectAt } = await import('./projects.ts')

    let done = 0
    const kept: { line: string; reason: string }[] = []
    const keep = (line: string, reason: string) => { kept.push({ line, reason }) }
    for (const r of rows) {
      if (r.age_days < days) {
        keep(`${r.id}  too recent (${r.age_days.toFixed(1)}d)`, 'under the age threshold')
        continue
      }
      if (!r.scored && !has('force')) {
        keep(`${r.id}  unscored — its diff is the evidence`, 'unscored — its diff is the evidence')
        continue
      }
      // Never reclaim a tree somebody else is still in. A project's own script
      // may name a directory by ticket key rather than by run, so several runs
      // legitimately share one — and one of them may be working right now.
      const busy = db().query(
        `SELECT COUNT(*) AS n FROM run
          WHERE worktree = ? AND id <> ? AND status IN ('running','asking')`,
      ).get(r.worktree, r.id) as { n: number }
      if (busy.n) {
        keep(`${r.id}  shared with ${busy.n} live run(s)`, 'shared with live run(s)')
        continue
      }
      if (dry) { console.log(`would reclaim ${r.id}  ${r.worktree}`); done++; continue }

      const repoRoot = repoRootOf(r.worktree) ?? projectAt(r.worktree)?.path ?? process.cwd()
      const w = { path: r.worktree, branch: r.branch ?? `orch/${r.id}`, base: '', repoRoot }
      const res = removeFor(w, repoRoot)
      if (res.removed) {
        db().query('UPDATE run SET worktree = NULL WHERE id = ?').run(r.id)
        console.log(`reclaimed ${r.id}  ${res.detail}`)
        if (res.output) console.log(res.output)
        done++
      } else {
        console.error(`could not reclaim ${r.id}: ${res.detail}`)
      }
    }

    /**
     * DATABASE ROWS ARE NOT AN INVENTORY OF WHAT IS ON DISK.
     *
     * A worktree whose row never acquired its path is invisible to the loop
     * above and would otherwise leak forever. Orphans are discovered from each
     * registered project's conventional worktree root, then held to a stricter
     * standard than remembered trees: both the files and the commits must be
     * reproducible from trunk. A failed proof keeps the directory, and a
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
        const marker = join(path, ORCH_RUN_MARKER)
        const ageDays = (Date.now() - statSync(existsSync(marker) ? marker : path).mtimeMs) / 86_400_000
        if (ageDays < days) {
          keep(`${label}  too recent (${ageDays.toFixed(1)}d)`, 'under the age threshold')
          continue
        }
        const trunk = typeof p.settings.trunk === 'string' && p.settings.trunk.trim()
          ? p.settings.trunk : null
        if (!trunk) {
          keep(`${label}  no trunk configured — cannot prove reachability`, 'no trunk configured')
          continue
        }
        const safe = orphanSafety(path, p.path, trunk)
        if (!safe.removable) {
          keep(`${label}  ${safe.detail}`, orphanKeepReason(safe.detail))
          continue
        }
        if (dry) { console.log(`would reclaim ${label}  ${safe.detail}`); done++; continue }

        const w = { path, branch: safe.branch, base: '', repoRoot: p.path }
        const res = removeFor(w, p.path)
        if (res.removed) {
          console.log(`reclaimed ${label}  ${res.detail}`)
          if (res.output) console.log(res.output)
          done++
        } else {
          keep(`${label}  removal refused`, 'removal refused')
          console.error(`could not reclaim ${label}: ${res.detail}`)
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
        const out = sweepWithTool(tool, p.path)
        if (!out.trim()) continue
        const lines = out.trim().split('\n')
        const omitted = Math.max(0, lines.length - 8)
        console.log(`\n${p.name} sweep:\n${lines.slice(-8).join('\n')}`)
        if (omitted) {
          console.log(`  (${omitted} earlier line${omitted === 1 ? '' : 's'} omitted)`)
        }
      }
    }

    printSweepKept(done, kept, dry)
    break
  }

  case 'discard': {
    const id = Number(argv[1])
    if (!id) usage()
    const row = db().query(
      'SELECT id, repo, cwd, worktree, branch, branch_kept, base_commit FROM run WHERE id = ?',
    ).get(id) as {
      id: number; repo: string | null; cwd: string | null; worktree: string | null
      branch: string | null; branch_kept: string | null; base_commit: string | null
    } | null
    if (!row) throw new Error(`no run ${id}`)
    if (!row.worktree) {
      if (!has('force') || !row.branch_kept) {
        throw new Error(`run ${id} has no worktree to discard`)
      }
      const repoRoot = cleanupRepoRoot(row)
      if (!repoRoot) throw new Error(`run ${id}'s repository root was not found`)
      const removed = removeBranch(repoRoot, row.branch_kept)
      if (removed) db().query('UPDATE run SET branch_kept=NULL WHERE id=?').run(id)
      console.log(removed
        ? `deleted branch ${row.branch_kept}`
        : `branch ${row.branch_kept} cleanup skipped: branch does not exist`)
      break
    }

    await discardWorktree(row as CleanupRow, ['running', 'asking'], 'discarded', has('force'))
    break
  }

  case 'stop': {
    const id = Number(argv[1])
    if (!id) usage()
    const row = db().query(
      `SELECT id, status, pid, agent_pid, parent_run_id, repo, cwd, worktree, branch,
              base_commit
         FROM run WHERE id = ?`,
    ).get(id) as {
      id: number; status: string; pid: number | null; agent_pid: number | null
      parent_run_id: number | null; repo: string | null; cwd: string | null
      worktree: string | null; branch: string | null; base_commit: string | null
    } | null
    if (!row) throw new Error(`no run ${id}`)
    if (row.status !== 'running') {
      throw new Error(`run ${id} is ${row.status}, not running — nothing to stop`)
    }

    const pids = [...new Set([row.agent_pid, row.pid].filter((pid): pid is number => Boolean(pid)))]
    for (const pid of pids) {
      try { process.kill(pid, 0) } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
      }
    }

    db().transaction(() => {
      db().query(
        "UPDATE run SET status='stopped', error='stopped by architect', failure_kind=NULL WHERE id=? AND status='running'",
      ).run(id)
      if (row.parent_run_id) {
        db().query(
          "UPDATE run SET status='stopped', error='stopped by architect', failure_kind=NULL WHERE id=?",
        ).run(row.parent_run_id)
      }
    })()

    // The coordinator owns setup and final recording. Killing it inside the
    // creation window strands the project tool's directory before it can be
    // attributed or reclaimed. Stop the vendor, but let the coordinator see
    // the stopped row and finish cleanup.
    terminateRunProcesses(id, row.pid ? [row.pid] : [])
    console.log(`stopped run ${id}`)
    if (row.worktree) {
      const stoppedWorktree = row.worktree
      await discardWorktree(row as CleanupRow, ['running', 'asking'], 'discarded', true)
      if (row.parent_run_id) {
        db().query('UPDATE run SET worktree=NULL WHERE id=? AND worktree=?')
          .run(row.parent_run_id, stoppedWorktree)
      }
    }
    break
  }

  case 'abandon': {
    const id = Number(argv[1])
    if (!id) usage()
    const row = db().query(
      'SELECT id, status, repo, cwd, worktree, branch, parent_run_id, base_commit FROM run WHERE id = ?',
    ).get(id) as {
      id: number; status: string; repo: string | null; cwd: string | null
      worktree: string | null; branch: string | null; parent_run_id: number | null
      base_commit: string | null
    } | null
    if (!row) throw new Error(`no run ${id}`)
    if (row.status !== 'asking') {
      throw new Error(`run ${id} is ${row.status}, not asking — nothing to abandon`)
    }

    const note = flag('note')
    const error = `abandoned by architect${note === undefined ? '' : `: ${note}`}`
    const at = nowIso()
    db().transaction(() => {
      db().query(
        "UPDATE run SET status='stale', error=?, failure_kind='abandoned' WHERE id=?",
      ).run(error, id)
      db().query(
        `UPDATE question SET answered_by='abandoned', answered_at=?, answer='(abandoned)'
          WHERE answered_at IS NULL AND run_id IN
            (SELECT id FROM run WHERE id=? OR parent_run_id=?)`,
      ).run(at, id, id)
      resolveRootFromLastTurn(db(), row.parent_run_id ?? row.id)
    })()
    console.log(`abandoned run ${id}`)

    if (row.worktree && existsSync(row.worktree)) {
      await discardWorktree(
        row as CleanupRow, ['running', 'asking'], 'abandoned', has('force'),
      )
      break
    }

    console.log(row.worktree
      ? `worktree ${row.worktree} was already gone`
      : `worktree cleanup skipped: run ${id} has no worktree`)
    if (!row.branch) {
      console.log(`branch cleanup skipped: run ${id} has no branch`)
      break
    }

    const branchOwner = db().query(
      'SELECT id FROM run WHERE branch=? AND id<>? ORDER BY id LIMIT 1',
    ).get(row.branch, id) as { id: number } | null
    if (branchOwner) {
      console.log(`branch ${row.branch} left because run ${branchOwner.id} records it`)
      break
    }

    const repoRoot = cleanupRepoRoot(row)
    if (!repoRoot) {
      console.log(`branch ${row.branch} cleanup skipped: repository root not found`)
      break
    }
    let protectedBranch: ReturnType<typeof unmergedBranch> = null
    if (!has('force')) {
      protectedBranch = unmergedBranch(repoRoot, row.branch, row.base_commit)
    }
    if (protectedBranch) {
      db().query('UPDATE run SET branch_kept=? WHERE id=?').run(row.branch, id)
      console.log(keptBranchLine(row.branch, protectedBranch.count, id))
      break
    }
    const removed = removeBranch(repoRoot, row.branch)
    console.log(removed
      ? `deleted branch ${row.branch}`
      : `branch ${row.branch} cleanup skipped: branch does not exist`)
    break
  }

  case 'score': {
    const requestedId = Number(argv[1])
    if (!requestedId) usage()
    const row = db().query(
      `SELECT root.id, root.agent, root.job, root.session_id, root.parent_run_id,
              root.failure_kind
         FROM run requested
         JOIN run root ON root.id = COALESCE(requested.parent_run_id, requested.id)
        WHERE requested.id = ?`,
    ).get(requestedId) as
      | { id: number; agent: string; job: string; session_id: string | null
          parent_run_id: number | null; failure_kind: FailureKind | null } | null
    if (!row) throw new Error(`no run ${requestedId}`)
    const id = row.id
    if (row.agent === '(pending)') {
      throw new Error(`run ${id} cannot be scored: its agent is the placeholder '(pending)'`)
    }
    if (has('void')) {
      db().query('UPDATE run SET evidence_excluded=? WHERE id=?')
        .run('voided with orch score --void', id)
      console.log(`voided run ${id}: retained run and output; excluded from routing evidence`)
      break
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
    // A PERSON scoring from the dashboard is the gate's one legitimate
    // exception, and it is named here rather than reimplemented elsewhere.
    //
    // The gate exists because an AGENT judging a run it did not read teaches
    // the router something false. Someone clicking a verdict has the output on
    // screen. The orchestrator's own dashboard used to bypass this by writing
    // the score table directly, which is the same exception made invisible;
    // `--scorer` records WHO judged it, so the exception is auditable instead.
    const scorer = flag('scorer')
    const owner = judgeability(row.session_id, sessionId())
    if (owner.verdict === 'foreign' && !has('force') && !scorer) {
      throw new Error(
        `run ${id} was made by another session — you did not read its output.\n` +
          `  its session:   ${owner.owner}\n` +
          `  your session:  ${sessionId()}\n\n` +
          `Scoring it teaches the router something you cannot know. Ask the session\n` +
          `that ran it to score it — on this machine that is a SendMessage away.\n` +
          `If you are certain (correcting a score you know to be wrong), --force.`,
      )
    }
    if (owner.verdict === 'anonymous') {
      console.error(
        `! no session id here, so ownership is unverified — run ${id} was made by ${owner.owner}`,
      )
    }

    // `orch score 279 none` and `orch score 279 full right` are both complete
    // judgements; quality is meaningless without something to judge.
    //
    // Read positionally past the flags, not by index: `orch score 279 none
    // --note "..."` put `--note` in the quality slot and was rejected as an
    // incoherent judgement, which is a confusing way to be told about a typo
    // you did not make.
    const words = argv.slice(2).filter(
      (a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv.slice(2)[i - 1] ?? ''),
    )
    const delivery = words[0] as Delivery | undefined
    const quality = words[1] as Quality | undefined
    const fidelity = words[2] as Fidelity | undefined
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

    const betterThan = flag('better-than')
    const loserIds = betterThan === undefined ? [] : parseRunIds(betterThan, '--better-than')
    if (loserIds.length) {
      recordDuels(id, loserIds, sessionId(), nowIso(), has('force'))
    }

    const scoredAt = nowIso()
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
    ).run(id, delivery, quality ?? null, scoredFidelity ?? null, flag('note') ?? null, scoredAt,
          scorer ?? process.env.ORCH_SCORER ?? 'claude')
    const w = weigh(delivery, quality ?? null, scoredFidelity ?? null)
    const axes = [delivery, quality, scoredFidelity].filter(Boolean).join(' ')
    console.log(
      `run ${id} (${row.agent}/${row.job}) scored ${axes}  [${w}]`,
    )
    break
  }

  case 'recalibrate': {
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
        ).run(row.id, ...fresh, nowIso(), sessionId())
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
      const countsA = axis.levels.map((level) => pairs.filter((p) => p[0] === level).length)
      const countsB = axis.levels.map((level) => pairs.filter((p) => p[1] === level).length)
      const distance = (a: string, b: string) => {
        const d = axis.levels.indexOf(a) - axis.levels.indexOf(b)
        return (d * d) / 4
      }
      const observed = pairs.reduce((sum, p) => sum + distance(p[0], p[1]), 0) / pairs.length
      let expected = 0
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
        expected += countsA[a]! * countsB[b]! * distance(axis.levels[a]!, axis.levels[b]!)
      }
      expected /= pairs.length * pairs.length
      if (expected === 0) {
        console.log(`${axis.name}: n=${pairs.length} kappa=n/a reading=not measurable`)
      } else {
        const kappa = 1 - observed / expected
        console.log(`${axis.name}: n=${pairs.length} kappa=${kappa.toFixed(3)} reading=${reading(kappa)}`)
      }
    }
    break
  }

  case 'runs': {
    const json = has('json')
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
      // A resumed chain belongs in the window when any of its turns executed
      // there, even if the root turn predates the cutoff.
      where.push(`EXISTS (
        SELECT 1 FROM run turn
         WHERE (turn.id = r.id OR turn.parent_run_id = r.id)
           AND turn.started_at >= ?
      )`)
      args.push(sinceFlag)
    }
    let rows = db().query(
      `SELECT r.id, r.started_at, r.agent, r.job, r.repo, r.latency_ms, r.vendor_tokens,
              current_run.status, s.delivery, s.quality,
              COALESCE(r.label, r.prompt_head) AS prompt_head, r.route_reason
              ${json ? ', r.cwd, r.session_id, r.vendor_cost_usd, r.probe, r.exit_code,'
                        + ' r.prompt_path, r.branch, r.branch_kept, r.retry_of' : ''}
         FROM run r
         JOIN run current_run ON current_run.id = (
           SELECT member.id FROM run member
            WHERE member.id = r.id OR member.parent_run_id = r.id
            ORDER BY member.turn DESC, member.id DESC LIMIT 1
         )
         LEFT JOIN score s ON s.run_id = r.id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY r.id DESC LIMIT ?`,
    ).all(...args, 100000) as Record<string, unknown>[]

    rows = rows.flatMap((r) => {
      const chain = resolveFailover(db(), Number(r.id))
      const final = chain.attempts.at(-1)!
      if (onlyUnscored) {
        const owed = db().query(
          `SELECT 1 ok FROM run r LEFT JOIN score s ON s.run_id=r.id
            WHERE r.id=? AND ${UNSCORED_WHERE}`,
        ).get(final.rootId)
        if (!owed) return []
      }
      const current = json ? {} : db().query(
        'SELECT status, latency_ms, vendor_tokens, route_reason FROM run WHERE id=?',
      ).get(final.id) as {
        status: string; latency_ms: number | null; vendor_tokens: number | null
        route_reason: string | null
      }
      const turns = json ? db().query(
        `SELECT id, started_at, latency_ms, vendor_tokens, vendor_cost_usd, status, turn
           FROM run WHERE id = ? OR parent_run_id = ?
          ORDER BY turn, id`,
      ).all(Number(r.id), Number(r.id)) : undefined
      return [{
        ...r, ...current,
        ...(turns ? { turns } : {}),
        answer_agent: final.agent,
        failover_chain: chain.attempts.map((attempt) => attempt.agent),
      }]
    }).slice(0, Number(flag('limit') ?? (json ? 100000 : 20)))

    // Unknown means absent from orch, not merely absent from this presentation
    // (for example because an id names a child turn or another filter excludes
    // it). Omission and non-existence are different facts for machine callers.
    const knownIds = requestedIds.length ? new Set(
      (db().query(
        `SELECT id FROM run WHERE id IN (${requestedIds.map(() => '?').join(',')})`,
      ).all(...requestedIds) as { id: number }[]).map((row) => row.id),
    ) : new Set<number>()
    const unknownIds = requestedIds.filter((id) => !knownIds.has(id))

    // JSON Lines, so a consumer can stream it and a truncated read loses only
    // the last record. This is a published interface: `hub` reads it rather
    // than opening orch.db, because a database shared between two concerns is
    // how two concerns quietly become one.
    if (json) {
      for (const r of rows) console.log(JSON.stringify(r))
      for (const id of unknownIds) console.log(JSON.stringify({ id, status: 'unknown', unknown: true }))
      break
    }

    if (!rows.length && !unknownIds.length) { console.log('no runs'); break }
    for (const r of rows) {
      const outcome = outcomeOf(r as OutcomeRow)
      const status = outcome.line.split(' - ', 1)[0]!
      console.log(
        `${String(r.id).padStart(4)}  ${String((r.failover_chain as string[]).join('→')).padEnd(6)} ${String(r.job).padEnd(14)}` +
          // 'running' is not a failure, and a null latency is not zero seconds.
          ` ${String(r.status === 'failed' ? status.toUpperCase() : status).padEnd(10)}` +
          ` ${dur(r.latency_ms as number | null).padStart(8)}  ${String(r.prompt_head).slice(0, 60)}`,
      )
      if (r.status === 'asking') console.log(`      ${outcome.line.slice(status.length + 3)}`)
      // The reason is where a fan-out says its exclusions ran out. Hiding it
      // here would leave the database honest and the human-facing command not.
      if (r.route_reason) console.log(`      route: ${String(r.route_reason)}`)
    }
    for (const id of unknownIds) console.log(`${String(id).padStart(4)}  unknown run id`)
    break
  }

  case 'guide': {
    const gs = guide(flag('job'))
    const size = (b: number) => (b >= 1024 ? `${Math.round(b / 1024)}KB` : `${Math.round(b)}B`)
    const tradeoffs: string[] = []
    let decided = 0, provisional = 0, blank = 0

    for (const g of gs) {
      console.log(`\n${g.job}  ${g.what}`)
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
            `${g.job}: ${g.best.agent} judges best, ${g.quickest.agent} is ` +
            `${dur(g.quickest.latencyMs)} vs ${dur(g.best.latencyMs)}`,
          )
        }
      }
      if (g.untried.length) console.log(`  untried  ${g.untried.join(', ')}`)
      for (const e of g.excluded) console.log(`  excluded ${e.agent}: ${e.why}`)
      console.log(`  routes to ${g.routesTo}   (${g.reason})`)
    }

    if (tradeoffs.length) {
      console.log('\n  Best and quickest disagree - pick on what the job needs:')
      for (const t of tradeoffs) console.log(`    ${t}`)
    }
    console.log(
      `\n  ${decided} job(s) decided by evidence, ${provisional} provisional, ${blank} with no runs.` +
      `\n  Latency is only comparable alongside prompt size - a fast answer to a` +
      `\n  small prompt is not a fast agent.`,
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
      console.log('job             agent        runs  judged    raw  shrunk  median    vendor tokens      cost')
      for (const r of rows) {
        const score = r.score === null ? '—' : `${(r.score * 100).toFixed(0)}%`
        const shrunk = r.shrunk === null ? '—' : `${(r.shrunk * 100).toFixed(0)}%`
        const cost = r.costUsd > 0 ? `$${r.costUsd.toFixed(4)}` : '—'
        // Failures are part of the score, so they are shown beside it rather than
        // left for someone to wonder why the percentage looks low.
        const judged = r.failures ? `${r.evidence}(${r.failures}f)` : String(r.evidence)
        console.log(
          `${r.job.padEnd(15)} ${r.agent.padEnd(11)} ${String(r.runs).padStart(5)} ${judged.padStart(7)}` +
            ` ${score.padStart(6)} ${shrunk.padStart(7)} ${dur(r.latencyMs).padStart(8)} ${r.tokens.toLocaleString().padStart(17)}` +
            ` ${cost.padStart(9)}`,
        )
      }
    }
    for (const matrix of matrices) {
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
    const p = pick(jobName, flag('agent'), 0, false, stack,
      { agents: avoid, models: distinctModels })
    const ev = evidenceFor(jobName, 0, stack)
    console.log(
      `${jobName} -> ${p.agent}   (${p.reason})\n` +
      `  evidence: ${ev.level === 'stack' ? `${ev.stack} only` : 'all stacks'}` +
      `${stack && ev.level === 'job' ? ` (too little on ${stack} to compare agents there)` : ''}\n`,
    )
    for (const c of ev.cands) {
      console.log(
        `  ${c.agent.padEnd(7)} ${c.eligible ? 'eligible' : 'excluded'.padEnd(8)}` +
          ` runs=${String(c.runs).padStart(3)} judged=${String(c.evidence).padStart(3)}` +
          ` score=${c.score === null ? "—" : (c.score * 100).toFixed(0) + "%"}` +
          ` shrunk=${c.shrunk === null ? "—" : (c.shrunk * 100).toFixed(0) + "%"}  ${c.why}`,
      )
    }
    console.log(`\n  (a rate steers routing only at ${MIN_SAMPLE}+ scored runs)`)
    break
  }

  case 'pending': {
    // Runs THIS session made that it has not judged. Exits 1 when any remain,
    // so a hook or a script can act on it.
    const rows = pendingForSession(sessionId())
    if (!rows.length) { console.log('nothing of yours is unscored'); break }
    console.log(`${rows.length} run${rows.length === 1 ? '' : 's'} you made are unscored:\n`)
    for (const r of rows) {
      console.log(`  orch score ${r.id} <none|partial|full> [wrong|mixed|right]   # ${r.agent}/${r.job}  ${r.prompt_head.slice(0, 40)}`)
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

    const update = db().query(
      `UPDATE run SET failure_kind = ?
        WHERE id = ? AND status IN ('failed', 'stale')
          AND (failure_kind = 'other' OR failure_kind IS NULL) AND error = ?`,
    )
    const apply = db().transaction(() => {
      let changed = 0
      for (const { row, kind } of matched) changed += update.run(kind, row.id, row.error).changes
      return changed
    })
    const changed = apply()
    console.log(`\n${changed} row${changed === 1 ? '' : 's'} reclassified.`)
    break
  }

  case 'doctor': {
    const { LOCAL_BASE_URL, LOCAL_MODEL, LOCAL_CONTEXT_TOKENS } =
      await import('./agents.ts')
    // Probed BEFORE the agent list is printed, not after it. Doctor used to
    // report `qwen-local ready` and `reachable NO` four lines apart and mean
    // both: the roster asked whether it was configured and the probe asked
    // whether it answered. Now the roster is told the answer first, so the
    // status column and the routing table below it cannot contradict
    // each other.
    const r = await ensureLocalHealth()
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
    }
    console.log(`\nlocal endpoint  ${LOCAL_BASE_URL || '(ORCH_LOCAL_BASE_URL unset)'}`)
    console.log(`local model     ${LOCAL_MODEL}`)
    console.log(`reachable       ${r.ok ? 'yes' : 'NO'} — ${r.detail}`)
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
    const notEvidence = NOT_EVIDENCE.map((kind) => `'${kind}'`).join(', ')
    const counts = db().query(
      `SELECT COUNT(*) runs,
              (SELECT COUNT(*) FROM score s JOIN run r2 ON r2.id = s.run_id
                WHERE COALESCE(r2.failure_kind, '') NOT IN (${notEvidence})) scored
         FROM run`,
    ).get() as { runs: number; scored: number }
    // unscoredCount(), not runs - scored: that subtraction counts probes,
    // in-flight runs, failures and abandoned rows as debt, and reported 28
    // owing where `orch pending` — the command that tells you what to do about
    // it — reported none.
    const owed = unscoredCount()
    console.log(`\nruns ${counts.runs}, scored ${counts.scored}, unscored ${owed}`)
    for (const j of Object.keys(JOBS)) {
      try { const p = pick(j); console.log(`  ${j.padEnd(15)} -> ${p.agent}`) }
      catch (e) { console.log(`  ${j.padEnd(15)} -> none (${(e as Error).message})`) }
    }
    break
  }

  case 'jobs':
    for (const j of Object.values(JOBS)) {
      const needs = Object.keys(j.needs).length ? ` [needs ${Object.keys(j.needs).join(',')}]` : ''
      // Fidelity judges adherence to a supplied implementation spec, so it is
      // visible here only on jobs that can change the repository.
      const axes = j.needs.writesRepo ? ' [axes delivery,quality,fidelity]' : ' [axes delivery,quality]'
      console.log(`${j.name.padEnd(15)} ${j.what}${needs}${axes}`)
    }
    break

  case 'agents':
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
