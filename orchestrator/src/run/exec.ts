/**
 * The detached worker's entry point, and the only file that may not break.
 *
 * A detached run is a FRESH `bun` process that imports this concern's source at
 * spawn time. So editing the orchestrator kills every run launched during the
 * edit: the child dies on import, before any of our code runs, before it can
 * fill in the row `detach()` already claimed for it. The caller sees nothing —
 * `bottega run start` printed an id and exited — and half an hour later the stale sweep
 * marks the row `interrupted`, which reads as "the room did something" rather
 * than "the orchestrator was mid-edit".
 *
 * That is not hypothetical. On 2026-09-02 runs 620, 621 and 622 died within
 * sixteen seconds of each other, from another session's work in one application, while
 * this file's neighbor `agents.ts` was momentarily unparseable during a
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
 * The raw SQLite terminal write happens before the shared publication path: the
 * current rule is that recording the local failure must not depend on imports,
 * migrations, machine identity, or hosted-record publication all being healthy.
 */
import { Database } from 'bun:sqlite'
import { RefusalError } from '../refusal-error.ts'

type RunDispatchSpec = import('../route/failover.ts').DetachSpec & {
  /** Agent whose MCP startup checks completed before the coordinator started. */
  dispatchMcpPreflightedAgent?: string
}

export function startupFailureDiagnostic(error: unknown): string {
  if (error instanceof RefusalError) return error.message
  return String((error as Error)?.stack ?? error)
}

/** Record why this run never started, using as little of the codebase as possible. */
async function recordStartupFailure(id: string, reason: string): Promise<void> {
  if (!id) return
  const path = process.env.BOTTEGA_ORCHESTRATOR_DB
  if (!path) return
  let changed = 0
  try {
    const database = new Database(path, { readwrite: true, create: false })
    database.exec('PRAGMA busy_timeout = 15000')
    changed = database
      .query(
        `UPDATE run SET status='failed', error=?, failure_kind='harness', latency_ms=0
         WHERE record_id=? AND status = 'running'`,
      )
      // Keep this status predicate paired with run-startup-failure.ts's shared writer.
      .run(reason.slice(0, 2000), id).changes
    database.close()
  } catch (error) {
    console.error(
      `orch: run ${id} could not record its startup failure: ${startupFailureDiagnostic(error)}`,
    )
    return
  }
  if (changed !== 1) return
  try {
    const { publishFailedReservedRun } = await import('./run-startup-failure.ts')
    publishFailedReservedRun(id)
  } catch (error) {
    // Detached stdio is the run's coordinator.log. Publication is best effort
    // only after the self-contained write above has made the outcome durable.
    console.error(
      `orch: run ${id} could not publish its startup failure: ${startupFailureDiagnostic(error)}`,
    )
  }
}

export async function main(argv: string[]): Promise<number> {
  const [idArg, promptPath, jobName, specJson] = argv
  const id = idArg ?? ''
  try {
    if (!id || !promptPath || !jobName)
      throw new Error('__exec <run-id> <prompt-file> <job> [spec]')
    const { readFileSync } = await import('node:fs')
    const { registerStandardRuntime } = await import('../runtime/runtime-registration.ts')
    registerStandardRuntime()
    const { run } = await import('./run.ts')
    const { detachedRunOptions } = await import('../route/failover.ts')
    const spec = JSON.parse(specJson ?? '{}') as RunDispatchSpec
    const prompt = readFileSync(promptPath, 'utf8')
    const { db } = await import('../database/db.ts')
    const continuation = db()
      .query('SELECT continuation_message_sha FROM run WHERE record_id=?')
      .get(id) as { continuation_message_sha: string | null } | null
    if (!continuation) throw new Error(`run ${id} disappeared before coordinator launch`)
    const { assertContinuationPromptCarriesPersistedMessage } = await import(
      './continuation-message.ts'
    )
    assertContinuationPromptCarriesPersistedMessage(
      prompt,
      continuation.continuation_message_sha,
      spec.resume?.continuationMessage,
    )
    await run({
      ...detachedRunOptions(jobName, prompt, id, spec),
      dispatchMcpPreflightedAgent: spec.dispatchMcpPreflightedAgent,
    })
    return 0
  } catch (e) {
    const message = String((e as Error)?.message ?? e)
    const diagnostic = startupFailureDiagnostic(e)
    /**
     * A failure BEFORE the agent ran is the orchestrator's, not the agent's.
     *
     * `run()` records its own outcome for anything that happens once it is
     * running, so reaching here means the run never really started — a broken
     * import, an unreadable prompt file, a malformed spec. `harness` is the kind
     * this codebase already reserves for "orchestrator was wrong", and like `unreachable`
     * and `interrupted` it is never counted as evidence about an agent.
     */
    await recordStartupFailure(id, message)
    console.error(`orch: run ${id} could not start: ${diagnostic}`)
    return 1
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
