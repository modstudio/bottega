// concern: run-control
/** Owns collection command behavior and exit mappings. Must not know CLI grammar. */
import type { Database } from 'bun:sqlite'
import { formatPeek, peekRun } from '../events.ts'
import { job } from '../jobs/jobs.ts'
import { reapStale } from '../run/run-liveness.ts'
import { isSyntheticLifecycleJob } from '../run/synthetic-lifecycle-job.ts'
import { collectResult, collectWait, resolveFailover, thinOutputWarning } from './collect.ts'

type Presentation = {
  log(...values: unknown[]): void
  error(...values: unknown[]): void
  exit(code: number): never
}

export function peekCommand(
  id: number,
  options: { events?: number; json: boolean },
  presentation: Presentation,
): void {
  if (options.events !== undefined && (!Number.isInteger(options.events) || options.events < 0))
    throw new Error('--events must be a non-negative integer')
  const summary = peekRun(id, { events: options.events })
  presentation.log(options.json ? JSON.stringify(summary) : formatPeek(summary))
}

export function resultCommand(
  database: Database,
  argv: string[],
  scoreSuffix: (jobName: string) => string,
  presentation: Presentation,
): void {
  collectResult(
    database,
    argv,
    scoreSuffix,
    presentation,
    (jobName) => !isSyntheticLifecycleJob(jobName) && Boolean(job(jobName).needs.writesRepo),
  )
  const chain = resolveFailover(database, Number(argv[1]))
  const row = database
    .query('SELECT job, status, latency_ms, probe, output_path FROM run WHERE id=?')
    .get(chain.finalId) as {
    job: string
    status: string
    latency_ms: number | null
    probe: number
    output_path: string | null
  }
  if (isSyntheticLifecycleJob(row.job)) return
  const warning = thinOutputWarning({ ...row, writesRepo: Boolean(job(row.job).needs.writesRepo) })
  if (warning) presentation.error(warning)
}

export async function waitCommand(database: Database, argv: string[]): Promise<void> {
  await collectWait(database, argv, reapStale)
}
