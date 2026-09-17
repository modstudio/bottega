/**
 * The detached worker's entry point, and the only file that may not break.
 *
 * A detached run is a FRESH `bun` process that imports this concern's source at
 * spawn time. So editing the orchestrator kills every run launched during the
 * edit: the child dies on import, before any of our code runs, before it can
 * fill in the row `detach()` already claimed for it. The caller sees nothing —
 * `orch do` printed an id and exited — and half an hour later the stale sweep
 * marks the row `interrupted`, which reads as "the room did something" rather
 * than "the orchestrator was mid-edit".
 *
 * That is not hypothetical. On 2026-09-02 runs 620, 621 and 622 died within
 * sixteen seconds of each other, from another session's work in one application, while
 * this file's neighbour `agents.ts` was momentarily unparseable during a
 * refactor. That session lost three surveys and could only report that orch
 * "was dropping runs for a stretch". Nothing was charged to any agent —
 * `interrupted` is already excluded from evidence — but the work was gone and
 * the cause was invisible.
 *
 * WHY THIS FILE IS SEPARATE. `program.ts` statically imports the whole graph, so a
 * syntax error anywhere in it takes the process down before `main()` is
 * reached and no `try` inside `main()` can help. This entry imports almost
 * nothing statically and pulls the rest in dynamically, INSIDE a catch — so a
 * broken sibling becomes a recorded failure with a reason, instead of silence.
 *
 * It writes that failure through `bun:sqlite` directly rather than through
 * `db.ts`, because `db.ts` runs migrations on open and the whole point here is
 * to be the code that still works when the code is broken.
 */
import { Database } from 'bun:sqlite'

const [idArg, promptPath, jobName, specJson] = process.argv.slice(2)
const id = Number(idArg)

/** Record why this run never started, using as little of the codebase as possible. */
function recordStartupFailure(reason: string): void {
  if (!id) return
  try {
    // The dispatcher always exports the already-resolved store to detached
    // workers. Do not independently derive either the current or legacy root.
    const path = process.env.ORCH_DB
    if (!path) return
    // `readwrite` explicitly: Bun refuses `{ create: false }` on its own with
    // "flags must include SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE", and
    // this function swallows its own errors by design — so the first version
    // recorded nothing at all and looked exactly like the silence it exists to
    // remove. `create` stays false because the database must already exist: the
    // row this is about was inserted into it moments ago.
    const d = new Database(path, { readwrite: true, create: false })
    d.exec('PRAGMA busy_timeout = 15000')
    // Only a row still claiming to run: never overwrite an outcome something
    // else already recorded.
    d.query(
      `UPDATE run SET status='failed', error=?, failure_kind='harness', latency_ms=0
        WHERE id=? AND status='running'`,
    ).run(reason.slice(0, 2000), id)
    d.close()
  } catch {
    // Out of places to put it. The stderr line below is the last word, and the
    // stale sweep remains the backstop it has always been.
  }
}

try {
  if (!id || !promptPath || !jobName) throw new Error('__exec <run-id> <prompt-file> <job> [spec]')
  const { readFileSync } = await import('node:fs')
  const { registerStandardRuntime } = await import('./runtime-registration.ts')
  registerStandardRuntime()
  const { run } = await import('./run.ts')
  const { detachedRunOptions } = await import('./failover.ts')
  const spec = JSON.parse(specJson ?? '{}') as import('./failover.ts').DetachSpec
  await run(detachedRunOptions(jobName, readFileSync(promptPath, 'utf8'), id, spec))
} catch (e) {
  const why = String((e as Error)?.stack ?? e)
  /**
   * A failure BEFORE the agent ran is the orchestrator's, not the agent's.
   *
   * `run()` records its own outcome for anything that happens once it is
   * running, so reaching here means the run never really started — a broken
   * import, an unreadable prompt file, a malformed spec. `harness` is the kind
   * this codebase already reserves for "orch was wrong", and like `unreachable`
   * and `interrupted` it is never counted as evidence about an agent.
   */
  recordStartupFailure(`the worker process could not start:\n${why}`)
  console.error(`orch: run ${id} could not start: ${why}`)
  process.exit(1)
}
