// concern: run-dispatch
/**
 * Knows detached dispatch, run rows, resume claims, and prompt artifacts. Must
 * not know transports, worktrees, routing policy, reviews, or the CLI.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { pidAlive } from '../../../shared/process-identity.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { callerCheckoutFacts, preflight } from '../dispatch/dispatch-preflight.ts'
import { job } from '../jobs/jobs.ts'
import { effectiveMcpRequest, preflightMcp, storedMcpRequest } from '../mcp/mcp-preflight.ts'
import { projectByName } from '../project/projects.ts'
import { signedInRecordUserId } from '../record/record-attribution.ts'
import type { DetachSpec } from '../route/failover.ts'
import { repoOf } from './run.ts'
import { runAlive } from './run-alive.ts'
import { RUNS_DIR, runFilePaths } from './run-artifacts.ts'
import { runCoordinatorLogPath } from './run-coordinator-log.ts'
import { runLeaseState } from './run-lease.ts'
import { ensureDispatchMcpMainStack } from './run-mcp-main-stack.ts'
import { claimIdentity, resumeFacts } from './run-resume-kind.ts'

/**
 * Claim a run id, hand the work to a process that outlives this one, and return.
 *
 * The id has to exist BEFORE the agent is picked, because the whole point is to
 * print it and exit — so a placeholder row is claimed here and `run()` fills it
 * in once it has routed. Until then the row reads agent `(pending)`, which is
 * true: nothing has been chosen yet.
 *
 * The child writes stdout and stderr to its per-run coordinator log and is
 * unref'd, so this process's event loop can drain and exit while the child keeps
 * going. That is the part every
 * caller-side workaround got wrong — a shell wrapper dies and takes the agent
 * with it, and `setsid` does not exist on macOS.
 */
export async function detach(
  jobName: string,
  prompt: string,
  spec: DetachSpec,
  selectedAgent?: string,
  spawnCoordinator: typeof spawn = spawn,
): Promise<number> {
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
  const mcpRequest = effectiveMcpRequest(spec.mcp, job(jobName))
  // A RESUME skips preflight: its agent was chosen long ago, its worktree
  // exists, and its seed was settled when that worktree was cut. Re-checking
  // would demand a `--seed` for a database that is already there.
  const firstTurn = resumeFacts(
    spec.resume?.kind ?? null,
    0,
    spec.resume?.parent ?? null,
  ).isFirstTurn
  const seed = !firstTurn
    ? spec.seed
    : preflight(
        jobName,
        cwd,
        spec.seed,
        spec.key,
        spec.base,
        false,
        false,
        spec.lens,
        spec.review,
        spec.carry,
        spec.repo,
      )
  if (firstTurn && mcpRequest) {
    // Who will run is knowable here, and a proven-failed grok attach must not
    // leave a placeholder for the child to fail. Resume keeps the agent that
    // already started; it is not a new dispatch.
    if (!selectedAgent) throw new Error('MCP preflight requires the selected agent')
    ensureDispatchMcpMainStack({ mcpRequest, cwd, projectName: spec.repo })
    preflightMcp({ mcp: mcpRequest, cwd, job: jobName, selectedAgent })
  }
  const runsDir = RUNS_DIR
  const startedByUserId = await signedInRecordUserId()
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
  // A resume is claimed as a chain member in this same INSERT. One SQLite
  // statement is the claim boundary: readers see either no new turn or a
  // running turn already linked to its chain.
  const claimed = writeTransaction(() => {
    const identity = claimIdentity(spec.resume)
    const continuationParent = identity.parent_run_id
    const projectName = spec.repo ?? repoOf(cwd)
    const projectId = projectName ? (projectByName(projectName)?.id ?? null) : null
    if (spec.resume?.kind === 'retry-root') {
      const branch = spec.resume.worktree?.branch ?? spec.resume.treePlan?.branch ?? null
      const tree = spec.resume.worktree?.path ?? null
      const possibleOwners = db()
        .query(
          `SELECT id,parent_run_id,status,pid,branch,worktree FROM run
           WHERE id=? OR parent_run_id=?
              OR (? IS NOT NULL AND branch=?) OR (? IS NOT NULL AND worktree=?)`,
        )
        .all(spec.resume.parent, spec.resume.parent, branch, branch, tree, tree) as {
        id: number
        parent_run_id: number | null
        status: string
        pid: number | null
        branch: string | null
        worktree: string | null
      }[]
      const liveOwner = possibleOwners.find((owner) => {
        const inOriginal =
          owner.id === spec.resume!.parent || owner.parent_run_id === spec.resume!.parent
        if (inOriginal && spec.resume!.retireAsking && owner.status === 'asking') return false
        return runAlive({
          status: owner.status,
          lease: runLeaseState(owner.id),
          pidAlive: Boolean(owner.pid && pidAlive(owner.pid)),
        })
      })
      if (liveOwner) {
        throw new Error(
          `run ${liveOwner.id} (${liveOwner.status}) is alive on the original chain or retained branch/tree; ` +
            `wait for it or orch abandon ${spec.resume.parent}`,
        )
      }
    }
    const inserted = db()
      .query(
        `INSERT INTO run (started_at, agent, job, repo, project_id, cwd, prompt_sha, spec_sha, prompt_bytes,
                      prompt_head, label, status, session_id, probe, parent_run_id, turn, mcp,
                      vendor_session, started_by_user_id)
       SELECT ?, '(pending)', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?
        WHERE ? IS NULL OR (
          EXISTS (SELECT 1 FROM run root WHERE root.id = ? AND root.status <> 'stale')
          AND NOT EXISTS (
            SELECT 1 FROM run
             WHERE (id = ? OR parent_run_id = ?) AND status = 'running'
          )
        )
       RETURNING id`,
      )
      .get(
        nowIso(),
        jobName,
        projectName,
        projectId,
        null,
        createHash('sha256').update(prompt).digest('hex').slice(0, 16),
        createHash('sha256').update(prompt).digest('hex').slice(0, 16),
        prompt.length,
        prompt.slice(0, 200).replace(/\s+/g, ' '),
        spec.label ?? null,
        sessionId(),
        spec.probe ? 1 : 0,
        continuationParent,
        identity.turn,
        storedMcpRequest(mcpRequest),
        spec.resume?.session ?? null,
        startedByUserId,
        continuationParent,
        continuationParent,
        continuationParent,
        continuationParent,
      ) as { id: number } | null
    const deliveryRoot =
      spec.resume?.parent ??
      (spec.retryOf
        ? (
            db()
              .query('SELECT COALESCE(parent_run_id,id) root_id FROM run WHERE id=?')
              .get(spec.retryOf) as { root_id: number } | null
          )?.root_id
        : undefined)
    if (inserted && deliveryRoot) {
      db()
        .query(
          `UPDATE question SET delivery_pending_at=NULL
          WHERE delivery_pending_at IS NOT NULL AND run_id IN
            (SELECT id FROM run WHERE id=? OR parent_run_id=?)`,
        )
        .run(deliveryRoot, deliveryRoot)
    }
    if (inserted && spec.resume?.kind === 'retry-root' && spec.resume.retireAsking) {
      db()
        .query(
          `UPDATE run SET status='failed',failure_kind='stopped',
             error='record-only rulings recovered by retry root'
           WHERE (id=? OR parent_run_id=?) AND status='asking'`,
        )
        .run(spec.resume.parent, spec.resume.parent)
    }
    return inserted
  })
  if (!claimed) {
    const root = db().query('SELECT status FROM run WHERE id=?').get(spec.resume!.parent) as {
      status: string
    } | null
    if (root?.status === 'stale') {
      throw new Error(`run ${spec.resume!.parent} is ${root.status} and cannot be continued`)
    }
    const running = db()
      .query(
        `SELECT id, turn FROM run
        WHERE (id = ? OR parent_run_id = ?) AND status = 'running'
        ORDER BY turn DESC, id DESC LIMIT 1`,
      )
      .get(spec.resume!.parent, spec.resume!.parent) as { id: number; turn: number }
    throw new Error(
      `run ${spec.resume!.parent} already has running turn ${running.id} (turn ${running.turn})`,
    )
  }
  const { id } = claimed
  let coordinatorLogFd: number | null = null
  let handoffStep = 'write prompt artifact'
  try {
    // The row now exists, so its id replaces that temporary random name and is
    // also stored on the row for run() to reuse rather than creating a second file.
    const promptPath = runFilePaths(runsDir, Date.now(), id, 'detach', jobName).prompt
    writeFileSync(promptPath, prompt)
    handoffStep = 'record prompt artifact'
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
    handoffStep = 'resolve coordinator executable'
    const [execPath, ...spawnArgs] = [
      ...bottegaEntryArgv('run-exec'),
      /**
       * `exec.ts`, not the `orch.ts` process entry point, and that is the whole point of it.
       *
       * A detached worker is a fresh process that imports this concern's source
       * at spawn time, so an edit anywhere in the graph kills every run launched
       * during it — the child dies on import, before it can fill in the row this
       * function already claimed. Three of another session's runs were lost that
       * way this morning and reported only as "orch was dropping runs".
       *
       * `program.ts` imports the full command graph, so no `try` inside it can catch
       * that. `exec.ts` imports almost nothing and pulls the rest in inside a
       * catch, turning a broken sibling into a recorded failure with a reason.
       */
      String(id),
      promptPath,
      jobName,
      JSON.stringify({ ...spec, seed }),
    ]
    handoffStep = 'resolve coordinator working directory'
    const spawnFacts = callerCheckoutFacts(cwd)
    handoffStep = 'open coordinator log'
    coordinatorLogFd = openSync(runCoordinatorLogPath(id, runsDir), 'a', 0o600)
    const spawnOpts = {
      cwd: spawnCwd(
        cwd,
        spawnFacts.registeredProjectPath,
        spawnFacts.linkedWorktree,
        existsSync(cwd),
        process.cwd(),
      ),
      // The child must not inherit this process's session id: the run row
      // already records the session that ASKED for the work, and run() would
      // otherwise re-stamp it from the child's environment.
      env: { ...process.env, ORCH_DETACHED: '1' },
      stdio: ['ignore', coordinatorLogFd, coordinatorLogFd] as ['ignore', number, number],
      detached: true,
    }

    handoffStep = 'spawn coordinator'
    const child: ChildProcess = spawnCoordinator(execPath, spawnArgs, spawnOpts)
    handoffStep = 'await coordinator spawn'
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

    // The WORKER's pid, recorded now rather than left to run() to overwrite with
    // the agent's. Without one, reapStale skips its liveness check entirely - the
    // check is guarded on `if (r.pid)` - so a worker that dies before it spawns
    // an agent leaves a row claiming to run for the full thirty-minute cutoff.
    // Four such rows were sitting on the dashboard as `(pending)`, one of them
    // for fifteen minutes.
    handoffStep = 'record coordinator pid'
    if (!child.pid) throw new Error('spawned coordinator has no pid')
    const pidUpdate = db().query('UPDATE run SET pid=? WHERE id=?').run(child.pid, id)
    if (pidUpdate.changes !== 1) {
      throw new Error(`coordinator pid update changed ${pidUpdate.changes} rows`)
    }
    child.unref()
    return id
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    db()
      .query(`UPDATE run SET status='failed', failure_kind='harness', error=? WHERE id=?`)
      .run(`detach handoff failed during ${handoffStep}: ${message}`, id)
    throw error
  } finally {
    if (coordinatorLogFd !== null) closeSync(coordinatorLogFd)
  }
}

/**
 * The directory the detached worker is spawned in. A continuation names the
 * worktree its chain last ran in, and a finished writing run's worktree has been
 * discarded; spawning into a missing directory fails with ENOENT on the
 * executable before run() can rebuild the tree. The recorded cwd still travels
 * in the spec, so only the process's starting directory falls back.
 */
export function spawnCwd(
  callerCheckout: string,
  registeredProjectPath: string | null,
  callerCheckoutIsLinkedWorktree: boolean,
  callerCheckoutExists: boolean,
  fallback: string,
): string {
  if (registeredProjectPath) return registeredProjectPath
  if (!callerCheckoutIsLinkedWorktree && callerCheckoutExists) return callerCheckout
  return fallback
}
