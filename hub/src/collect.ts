import { sendOperatorNotification } from '../../shared/operator-notification.ts'
import { db, nowIso, writeTransaction } from './db.ts'
import {
  type HostedChangeLegReport,
  hostedChangeLegLine,
  pullHostedNoteChanges,
  pullHostedTaskChanges,
} from './hosted-change-cache.ts'
import { ingestGit } from './ingest/git.ts'
import { ingestRuns } from './ingest/runs.ts'
import {
  ingestTrackers,
  type TrackerResult,
  trackerLegError,
  trackerProjects,
} from './ingest/trackers.ts'
import { ingestTranscripts } from './ingest/transcripts.ts'
import { pullHostedNotes } from './note-cache.ts'
import { deliverOperatorWaitingEmails } from './operator-waiting-email.ts'
import { claimWaitingNotifications } from './orch.ts'
import { rollUpDays } from './query.ts'
import { pullHostedReports } from './report-cache.ts'
import { type SyncResult, syncEvidence } from './sync.ts'
import { pullHostedTasks } from './task-cache.ts'
import { hoursAgo } from './time.ts'

/**
 * Two cadences, because the legs cost very different amounts.
 *
 * Transcripts and runs are local reads over a short window and take under a
 * second; the trackers are four remote round trips and take seconds, so they
 * run rarely. Git is cheap but only changes on commit, so it rides with them.
 */
const FAST_MS = 20_000
export const SLOW_MS = 5 * 60_000

const QUIET_MAX_MS = 15 * 60_000
const FAILURE_MAX_MS = 60 * 60_000

type PollState = { nextAt: number; quiet: number; failures: number }

/**
 * Per-project adaptive cadence for the watch loop.
 *
 * A changing tracker stays on the five-minute floor. Quiet trackers step to
 * ten and then fifteen minutes. Failures double out to an hour, so an outage
 * cannot produce a request every tick. State is deliberately process-local:
 * restarting or explicitly collecting means "fresh now", not "honor an old
 * delay". The injected clock keeps this policy deterministic in tests.
 */
export class TrackerPollSchedule {
  private state = new Map<string, PollState>()
  private clock: () => number

  constructor(clock: () => number = Date.now) {
    this.clock = clock
  }

  due(projects: readonly string[]): Set<string> {
    const now = this.clock()
    return new Set(projects.filter((project) => (this.state.get(project)?.nextAt ?? 0) <= now))
  }

  record(result: TrackerResult) {
    if (result.project === 'backfill') return
    const previous = this.state.get(result.project) ?? {
      nextAt: 0,
      quiet: 0,
      failures: 0,
    }
    const failed = Boolean(result.error || result.skipped)
    const failures = failed ? previous.failures + 1 : 0
    const quiet = failed ? previous.quiet : result.activity ? 0 : previous.quiet + 1
    const delay = failed
      ? Math.min(SLOW_MS * 2 ** failures, FAILURE_MAX_MS)
      : result.activity
        ? SLOW_MS
        : Math.min(SLOW_MS * (quiet + 1), QUIET_MAX_MS)
    this.state.set(result.project, {
      nextAt: this.clock() + delay,
      quiet,
      failures,
    })
  }
}

const trackerSchedule = new TrackerPollSchedule()

export type CollectLegResult =
  | { source: string; ok: true; hostedChanges?: HostedChangeLegReport }
  | { source: string; ok: false; error: string }

export function formatCollectLeg(result: CollectLegResult): string {
  const separator = result.source.length >= 18 ? ' ' : ''
  if (!result.ok) return `${result.source.padEnd(18)}${separator}FAILED: ${result.error}`
  if (result.hostedChanges)
    return `${result.source.padEnd(18)}${separator}${hostedChangeLegLine(result.hostedChanges)}`
  return `${result.source.padEnd(18)}ok`
}

async function settleLeg(source: string, work: () => Promise<unknown>): Promise<CollectLegResult> {
  try {
    await work()
    return { source, ok: true }
  } catch (error) {
    const message = (error as Error).message
    console.error(`hub: ${source} collect failed: ${message}`)
    return { source, ok: false, error: message }
  }
}

type HostedCollectDependencies = {
  evidence?: () => Promise<SyncResult>
  tasks?: () => Promise<unknown>
  changes?: () => Promise<HostedChangeLegReport | null | undefined>
  noteChanges?: () => Promise<HostedChangeLegReport | null | undefined>
  notes?: () => Promise<unknown>
  reports?: () => Promise<unknown>
}

export async function hostedCollectLegs(
  guard?: LeaseGuard,
  dependencies: HostedCollectDependencies = {},
): Promise<CollectLegResult[]> {
  const evidence = async () => {
    const result = await (dependencies.evidence ?? syncEvidence)()
    if (result.interval.issues.length > 0)
      throw new Error(
        `interval sync issues: ${result.interval.issues
          .map((issue) => `${issue.project ?? '(no project)'}: ${issue.reason}`)
          .join('; ')}`,
      )
  }
  const legs = [
    ['hosted evidence', evidence],
    ['hosted tasks', dependencies.tasks ?? pullHostedTasks],
    ['hosted notes', dependencies.notes ?? pullHostedNotes],
    ['hosted reports', dependencies.reports ?? pullHostedReports],
  ] as const
  const results: CollectLegResult[] = []
  let previous: string | undefined
  for (const [source, work] of legs) {
    guard?.assertHeld(previous)
    results.push(await settleLeg(source, work))
    previous = source
    guard?.assertHeld(source)
    const changeWork =
      source === 'hosted tasks'
        ? { name: 'hosted task changes', work: dependencies.changes ?? pullHostedTaskChanges }
        : source === 'hosted notes'
          ? { name: 'hosted note changes', work: dependencies.noteChanges ?? pullHostedNoteChanges }
          : null
    if (!changeWork) continue
    const changeResult = await settleChangeLeg(changeWork.name, changeWork.work)
    if (!changeResult) continue
    results.push(changeResult)
    previous = changeResult.source
    guard?.assertHeld(previous)
  }
  return results
}

async function settleChangeLeg(
  source: string,
  work: () => Promise<HostedChangeLegReport | null | undefined>,
): Promise<CollectLegResult | null> {
  try {
    const report = await work()
    if (report == null) return null
    return { source, ok: true, hostedChanges: report }
  } catch (error) {
    const message = (error as Error).message
    console.error(`hub: ${source} collect failed: ${message}`)
    return { source, ok: false, error: message }
  }
}

/** Long enough to outlast a slow pass, short enough that a dead holder frees it. */
export const COLLECT_LEASE_MS = 60_000
const LEASE_RENEW_MS = 20_000

export type LeaseGuard = {
  /** Refuse further work after another holder has taken this lease. */
  assertHeld(afterLeg?: string): void
}

class LeaseLostError extends Error {
  readonly heldBy: string | null

  constructor(heldBy: string | null, afterLeg?: string) {
    super(
      `${heldBy ?? 'another process'} holds the collect lease; collection stopped${
        afterLeg ? ` after ${afterLeg}` : ''
      }; a leg already running was allowed to finish`,
    )
    this.heldBy = heldBy
  }
}

type HeldLeaseResult<T> =
  | { ran: true; value: T }
  | { ran: false; heldBy: string | null; error: LeaseLostError }

/** Run work under one renewing lease that has already been acquired. */
async function holdAndRenewLease<T>(
  holder: string,
  fn: (guard: LeaseGuard) => Promise<T>,
  renewEveryMs: number,
): Promise<HeldLeaseResult<T>> {
  let lostBy: string | null | undefined
  const markLost = () => {
    if (lostBy === undefined) lostBy = leaseHolder()
  }
  const guard: LeaseGuard = {
    assertHeld(afterLeg) {
      if (lostBy === undefined && leaseHolder() !== holder) markLost()
      if (lostBy !== undefined) throw new LeaseLostError(lostBy, afterLeg)
    },
  }
  const renewal = setInterval(() => {
    if (lostBy === undefined && !acquireLease(holder)) markLost()
  }, renewEveryMs)
  try {
    const value = await fn(guard)
    guard.assertHeld()
    return { ran: true, value }
  } catch (error) {
    if (lostBy !== undefined) {
      const refusal = error instanceof LeaseLostError ? error : new LeaseLostError(lostBy)
      return { ran: false, heldBy: lostBy, error: refusal }
    }
    throw error
  } finally {
    clearInterval(renewal)
    releaseLease(holder)
  }
}

/**
 * Only one process collects at a time, across the whole machine.
 *
 * The server collects so the page is fresh while it is open, and a launchd
 * daemon collects so it is fresh when it is not. Both running means two writers
 * doing identical work — and the transcripts leg CLEARS a session's spans
 * before reinserting them, so an interleaved pair can have one process delete
 * rows the other is midway through writing.
 *
 * An in-process flag cannot see another process, so the lease lives in the
 * database. Acquisition is a single conditional UPDATE, which SQLite settles
 * atomically; whoever wins renews it each cycle and the loser simply waits.
 * A holder that dies renews nothing and the lease expires on its own.
 */
export function acquireLease(holder: string): boolean {
  const now = Date.now()
  const row = writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO setting (key, value) VALUES ('collect.lease', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
          WHERE COALESCE(json_extract(setting.value, '$.until'), 0) <= ?
             OR json_extract(setting.value, '$.holder') = ?`,
      )
      .run(JSON.stringify({ holder, until: now + COLLECT_LEASE_MS }), now, holder)
    return conn
      .query<{ value: string }, []>(`SELECT value FROM setting WHERE key = 'collect.lease'`)
      .get()
  })
  try {
    return (JSON.parse(row!.value) as { holder: string }).holder === holder
  } catch {
    return false
  }
}

/**
 * Hand the lease back on the way out.
 *
 * Without this, stopping the dashboard leaves a lease nobody is renewing and
 * the daemon waits out its full sixty seconds before taking over — measured,
 * and a minute of a stale page for no reason. A holder that CRASHES still
 * relies on expiry, which is why the timeout exists at all.
 */
export function releaseLease(holder: string) {
  writeTransaction((conn) =>
    conn
      .query(
        `DELETE FROM setting WHERE key = 'collect.lease'
       AND json_extract(value, '$.holder') = ?`,
      )
      .run(holder),
  )
}

/**
 * Run something holding the lease, WAITING for it rather than racing it.
 *
 * `watch()` may skip a cycle when another process is collecting - there will be
 * another along in twenty seconds. A one-shot `hub collect` and the refresh
 * button cannot skip: somebody asked for this pass specifically, and a backfill
 * over thirty days has no next cycle to fall back on.
 *
 * They must not simply barge in either, which is what they did. `hub collect`
 * called collect() directly and never touched the lease, so it interleaved
 * freely with the server's watcher and the launchd daemon - and the transcripts
 * leg CLEARS a session's spans before reinserting them. Measured: two identical
 * collects run beside `hub serve` disagreed by two hours on one project, and
 * were byte-identical the moment the server was stopped.
 *
 * The wait is generous next to the work - a fast pass is ~300ms and a slow one
 * a few seconds - so in practice this returns immediately or after one cycle.
 */
export async function withLease<T>(
  holder: string,
  fn: (guard: LeaseGuard) => Promise<T>,
  waitMs = 30_000,
  renewEveryMs = LEASE_RENEW_MS,
): Promise<{ ran: true; value: T } | { ran: false; heldBy: string | null }> {
  const deadline = Date.now() + waitMs
  while (!acquireLease(holder)) {
    if (Date.now() >= deadline) return { ran: false, heldBy: leaseHolder() }
    await new Promise((r) => setTimeout(r, 250))
  }
  const result = await holdAndRenewLease(holder, fn, renewEveryMs)
  return result.ran ? result : { ran: false, heldBy: result.heldBy }
}

export function leaseHolder(): string | null {
  const row = db()
    .query<{ value: string }, []>(`SELECT value FROM setting WHERE key = 'collect.lease'`)
    .get()
  if (!row) return null
  try {
    const l = JSON.parse(row.value) as { holder: string; until: number }
    return l.until > Date.now() ? l.holder : null
  } catch {
    return null
  }
}

const stamp = (key: string) =>
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO setting (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(nowIso())),
  )

/**
 * How far back the fast runs collect looks.
 *
 * The rolling two-hour window is the ceiling when collection is current. If
 * the last successful ingest (collect.runs.at) is older than that, --since
 * is that watermark so a gap is caught up rather than skipped.
 */
export function runsSince(now = Date.now()): string {
  const windowStart = new Date(now - 2 * 3600_000).toISOString()
  const row = db()
    .query<{ value: string }, []>(`SELECT value FROM setting WHERE key = 'collect.runs.at'`)
    .get()
  if (!row) return windowStart
  let last: string
  try {
    const parsed = JSON.parse(row.value)
    last = typeof parsed === 'string' ? parsed : row.value
  } catch {
    last = row.value
  }
  if (!Number.isFinite(Date.parse(last))) return windowStart
  return last < windowStart ? last : windowStart
}

/**
 * The cheap legs: what changed in the last couple of hours.
 *
 * Two hours rather than the whole window because a span that changed is a
 * recent one, and re-reading thirty days every twenty seconds would burn the
 * machine re-deriving rows that cannot have moved. A missed collect looks
 * further back, to collect.runs.at, so an answer older than two hours is
 * not skipped.
 */
export async function collectFast(
  dependencies: { runs?: typeof ingestRuns; transcripts?: typeof ingestTranscripts } = {},
  guard?: LeaseGuard,
) {
  const results = [] as CollectLegResult[]
  guard?.assertHeld()
  results.push(await settleLeg('runs', () => (dependencies.runs ?? ingestRuns)(runsSince())))
  guard?.assertHeld('runs')
  results.push(
    await settleLeg('transcripts', () =>
      (dependencies.transcripts ?? ingestTranscripts)(hoursAgo(2)),
    ),
  )
  guard?.assertHeld('transcripts')
  rollUpDays()
  guard?.assertHeld('roll up days')
  stamp('collect.at')
  return results
}

/** Claim and deliver each waiting episode without allowing notification failure to stop collection. */
export async function deliverOperatorNotifications(
  dependencies: {
    claim?: typeof claimWaitingNotifications
    notify?: typeof sendOperatorNotification
    error?: (message: string) => void
  } = {},
): Promise<void> {
  const claim = dependencies.claim ?? claimWaitingNotifications
  const notify = dependencies.notify ?? sendOperatorNotification
  const error = dependencies.error ?? console.error
  let items: Awaited<ReturnType<typeof claimWaitingNotifications>>
  try {
    items = await claim()
  } catch (cause) {
    error(`hub: operator notification claim failed: ${String(cause)}`)
    return
  }
  for (const item of items) {
    try {
      notify(item.notification)
    } catch (cause) {
      error(`hub: operator notification delivery failed: ${String(cause)}`)
    }
  }
}

/** The remote and commit-shaped legs. */
async function collectSlow(scheduled = false, guard?: LeaseGuard) {
  const results = [] as CollectLegResult[]
  guard?.assertHeld()
  results.push(await settleLeg('git', () => ingestGit(hoursAgo(24 * 7).slice(0, 10))))
  guard?.assertHeld('git')
  const due = scheduled ? trackerSchedule.due(trackerProjects()) : null
  let trackerResults: TrackerResult[] = []
  results.push(
    await settleLeg('tasks', async () => {
      trackerResults = due?.size === 0 ? [] : await ingestTrackers(due)
      if (scheduled) for (const result of trackerResults) trackerSchedule.record(result)
      const error = trackerLegError(trackerResults)
      if (error) throw new Error(error)
    }),
  )
  guard?.assertHeld('tasks')
  stamp('collect.slow.at')
  if (process.env.HUB_HOSTED_URL) {
    guard?.assertHeld('tasks')
    results.push(...(await hostedCollectLegs(guard)))
    guard?.assertHeld('hosted')
  }
  guard?.assertHeld(process.env.HUB_HOSTED_URL ? 'hosted reports' : 'tasks')
  stamp('collect.at')
  return results
}

const UNGUARDED_LEASE: LeaseGuard = { assertHeld() {} }

export async function collectOnce(
  since: string,
  only?: string,
  guard: LeaseGuard = UNGUARDED_LEASE,
) {
  const selected = (source: string) => !only || only === source
  const results = [] as CollectLegResult[]
  let previous: string | undefined
  if (selected('git')) {
    guard.assertHeld(previous)
    results.push(await settleLeg('git', () => ingestGit(since.slice(0, 10))))
    previous = 'git'
    guard.assertHeld(previous)
  }
  if (selected('runs')) {
    guard.assertHeld(previous)
    results.push(await settleLeg('runs', () => ingestRuns(since)))
    previous = 'runs'
    guard.assertHeld(previous)
  }
  if (selected('transcripts')) {
    guard.assertHeld(previous)
    results.push(await settleLeg('transcripts', () => ingestTranscripts(since)))
    previous = 'transcripts'
    guard.assertHeld(previous)
  }
  if (selected('tasks')) {
    guard.assertHeld(previous)
    results.push(
      await settleLeg('tasks', async () => {
        const trackerResults = await ingestTrackers()
        for (const result of trackerResults) {
          const note = result.skipped
            ? `skipped: ${result.skipped}`
            : result.error
              ? `FAILED: ${result.error}`
              : `${result.tasks} tasks, ${result.changed} status changes`
          console.log(`${`tracker/${result.project}`.padEnd(21)}${note}`)
        }
        const error = trackerLegError(trackerResults)
        if (error) throw new Error(error)
      }),
    )
    previous = 'tasks'
    guard.assertHeld(previous)
  }
  if (!only && process.env.HUB_HOSTED_URL) {
    guard.assertHeld(previous)
    results.push(...(await hostedCollectLegs(guard)))
    previous = 'hosted reports'
    guard.assertHeld(previous)
  }
  guard.assertHeld(previous)
  rollUpDays()
  guard.assertHeld('roll up days')
  stamp('collect.at')
  return results
}

/**
 * Collect on a clock until stopped.
 *
 * Used by `hub collect --watch` under launchd and by `hub serve`, which is why
 * it takes a holder name: whichever acquires the lease does the work, and the
 * other waits without duplicating it.
 */
export function watch(
  holder: string,
  onError = (e: Error) => console.error(`hub: ${e.message}`),
  dependencies: {
    initial?: (guard: LeaseGuard) => Promise<unknown>
    fast?: (guard: LeaseGuard) => Promise<unknown>
    slow?: (guard: LeaseGuard) => Promise<unknown>
    renewEveryMs?: number
  } = {},
) {
  let busy = false
  let stopping = false
  const runCycle = (work: (guard: LeaseGuard) => Promise<unknown>) => async () => {
    if (stopping || busy || !acquireLease(holder)) return
    busy = true
    // A failed collect must not stop the loop or take the server down: the
    // stored data is still the last good reading, which is the point of having
    // stored it.
    try {
      const result = await holdAndRenewLease(
        holder,
        work,
        dependencies.renewEveryMs ?? LEASE_RENEW_MS,
      )
      if (!result.ran) onError(result.error)
    } catch (e) {
      onError(e as Error)
    } finally {
      busy = false
    }
  }

  const fast = runCycle(
    dependencies.fast ??
      (async (leaseGuard) => {
        leaseGuard.assertHeld()
        await deliverOperatorNotifications()
        leaseGuard.assertHeld('operator notifications')
        await deliverOperatorWaitingEmails()
        leaseGuard.assertHeld('operator waiting emails')
        await collectFast({}, leaseGuard)
      }),
  )
  const slow = runCycle(dependencies.slow ?? ((leaseGuard) => collectSlow(true, leaseGuard)))
  // The old pair of fire-and-forget calls made `slow` observe `busy` from
  // `fast` and skip the initial tracker pass. Keep both initial legs under the
  // same guard so scheduling starts with a real observation.
  const initial =
    dependencies.initial ??
    (async (leaseGuard) => {
      leaseGuard.assertHeld()
      await deliverOperatorNotifications()
      leaseGuard.assertHeld('operator notifications')
      await deliverOperatorWaitingEmails()
      leaseGuard.assertHeld('operator waiting emails')
      await collectFast({}, leaseGuard)
      await collectSlow(true, leaseGuard)
    })
  void runCycle(initial)()
  const a = setInterval(() => void fast(), FAST_MS)
  const b = setInterval(() => void slow(), SLOW_MS)

  const stop = async () => {
    stopping = true
    clearInterval(a)
    clearInterval(b)
    while (busy) await Bun.sleep(10)
    releaseLease(holder)
  }
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      await stop()
      process.exit(0)
    })
  }
  return stop
}
