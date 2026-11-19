// concern: record-sync-command
/** Owns sync command presentation. Must not know record schema or run execution. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { readMachineValue } from '../../../shared/machine-config.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { automaticallyAdoptHostedBoard } from '../board/board-auto-adoption.ts'
import { syncRecord } from './record-sync.ts'
import { recordTunnelFailure } from './record-tunnel-error.ts'

export function quarantinedOutboxLines(
  rows: Awaited<ReturnType<typeof syncRecord>>['quarantined'],
): string[] {
  return rows.map((row) => `quarantined ${row.id}\t${row.kind}\t${row.error}`)
}

export function blockedOutboxLines(
  rows: Awaited<ReturnType<typeof syncRecord>>['blocked'],
): string[] {
  return rows.map(
    (row) =>
      `blocked ${row.id}\t${row.kind}\t${row.reason ?? `retired parent ${row.parentRecordId}`}`,
  )
}

export function readOnlyDeferredLines(
  rows: NonNullable<Awaited<ReturnType<typeof syncRecord>>['readOnlyDeferred']>,
): string[] {
  return rows.map((row) => `deferred ${row.rows}\tread-only space ${row.spaceId}`)
}

function heldOutboxLines(
  rows: NonNullable<Awaited<ReturnType<typeof syncRecord>>['held']>,
): string[] {
  return rows.map((row) => `held ${row.rows}\t${row.kind}\t${row.reason}`)
}

function routingHeldOutboxLines(
  rows: NonNullable<Awaited<ReturnType<typeof syncRecord>>['routingHeld']>,
): string[] {
  return rows.map((row) => `held orch:${row.id}\t${row.kind}\t${row.reason}`)
}

export function routingPoolLine(
  pool: NonNullable<Awaited<ReturnType<typeof syncRecord>>['routingPool']>,
): string {
  return `routing pool: ${pool.added} added, ${pool.updated} updated, ${pool.caughtUp ? 'caught up' : 'filling'}`
}

export function projectRegisterLines(
  pull: NonNullable<Awaited<ReturnType<typeof syncRecord>>['projectRegister']>,
): string[] {
  return [
    `project register: ${pull.updated} updated, ${pull.retired} retired, ${pull.unretired} un-retired, ${pull.skipped} skipped`,
    ...pull.warnings.map((warning) => `project register skipped: ${warning}`),
  ]
}

function logProjectRegister(
  pull: Awaited<ReturnType<typeof syncRecord>>['projectRegister'],
  presentation: { log(value: string): void },
): void {
  if (!pull) return
  for (const line of projectRegisterLines(pull)) presentation.log(line)
}

function logRecordCacheCounts(
  result: Awaited<ReturnType<typeof syncRecord>>,
  presentation: { log(value: string): void },
): void {
  for (const [count, label] of [
    [result.orphans, 'record cache orphans'],
    [result.deletesBlocked, 'record cache deletes blocked'],
    [result.purgeKept, 'record cache purge rows kept'],
    [result.skippedDocs, 'record cache docs skipped'],
    [result.skippedSubjects, 'record cache subjects skipped'],
  ] as const)
    if (count) presentation.log(`${label}: ${count}`)
  if (result.purgeWarning) presentation.log(`record cache purge warning: ${result.purgeWarning}`)
  for (const line of waitingOnUnregisteredLines(result.waitingOnUnregistered ?? []))
    presentation.log(line)
}

export function waitingOnUnregisteredLines(
  rows: NonNullable<Awaited<ReturnType<typeof syncRecord>>['waitingOnUnregistered']>,
): string[] {
  const waitingByProject = new Map<string, Set<string>>()
  for (const row of rows) {
    const docs = waitingByProject.get(row.project) ?? new Set<string>()
    docs.add(row.docId)
    waitingByProject.set(row.project, docs)
  }
  return [...waitingByProject]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([project, docs]) =>
        renderRefusal(
          refusal(
            `record cache waiting: ${docs.size} ${docs.size === 1 ? 'doc' : 'docs'} on unregistered project ${project}`,
            { kind: 'command', argv: [PLATFORM_SLUG, 'project', 'add', project] },
          ),
        ),
    )
}

function logHeldRows(
  result: Awaited<ReturnType<typeof syncRecord>>,
  presentation: { log(value: string): void },
): void {
  for (const line of heldOutboxLines(result.held ?? [])) presentation.log(line)
  for (const line of routingHeldOutboxLines(result.routingHeld ?? [])) presentation.log(line)
  for (const line of routingHeldOutboxLines(result.parentDeferred ?? [])) presentation.log(line)
  for (const line of quarantinedParentHeldLines(result.quarantinedParentHolds ?? []))
    presentation.log(line)
}

export function quarantinedParentHeldLines(
  rows: NonNullable<Awaited<ReturnType<typeof syncRecord>>['quarantinedParentHolds']>,
): string[] {
  return rows.map(
    (row) =>
      `held: orch:${row.id} ${row.kind} is quarantined at ${row.quarantinedAt}; ${row.rows} rows wait on it; ${quarantinedParentRemedy(row.id)}`,
  )
}

function quarantinedParentRemedy(id: number): string {
  return `retry it with ${PLATFORM_SLUG} record outbox retry orch:${id}, or retire it with ${PLATFORM_SLUG} record outbox retire orch:${id} --reason <text>`
}

export async function syncCommand(
  options: { backfill: boolean },
  presentation: { log(value: string): void },
  dependencies = {
    sync: syncRecord,
    boardAdoption: {} as Parameters<typeof automaticallyAdoptHostedBoard>[1],
  },
): Promise<void> {
  let result: Awaited<ReturnType<typeof syncRecord>>
  try {
    result = await dependencies.sync({ backfill: options.backfill })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const enhanced = recordTunnelFailure(message, {
      tunnelApp: readMachineValue('record.tunnel_app'),
      requiresTunnel: false,
    })
    if (enhanced === message) throw error
    throw new Error(enhanced, { cause: error })
  }
  await automaticallyAdoptHostedBoard(presentation, dependencies.boardAdoption)
  for (const line of result.historyUploadLines ?? []) presentation.log(line)
  if (result.backfill) {
    presentation.log(
      `backfill enqueued ${result.backfill.enqueued}, refreshed-links ${result.backfill.refreshedLinks}, refreshed-numbers ${result.backfill.refreshedNumbers}, refreshed-roots ${result.backfill.refreshedRoots}, skipped-released ${result.backfill.skippedReleased}, skipped-live ${result.backfill.skippedLive}`,
    )
    presentation.log(`brief injection backfill enqueued ${result.backfill.briefInjections}`)
    presentation.log(`context review backfill enqueued ${result.backfill.contextReviews}`)
    presentation.log(`hook emission backfill enqueued ${result.backfill.hookEmissions}`)
    presentation.log(`score backfill enqueued ${result.backfill.scores}`)
    presentation.log(
      `review backfill enqueued ${result.backfill.reviews.enqueuedReviews} reviews and ${result.backfill.reviews.enqueuedReads} reads`,
    )
    const evidence = result.backfill.landingEvidence
    presentation.log(
      `landing evidence backfill enqueued ${evidence.enqueuedLandings}, ${evidence.enqueuedOverrides}, ${evidence.enqueuedCarries}, ${evidence.enqueuedContentions}, ${evidence.enqueuedFlakes}, ${evidence.enqueuedPullRequestCi}`,
    )
    presentation.log(`release backfill enqueued ${result.backfill.releases.enqueued}`)
  }
  if (!result.configured) {
    presentation.log('no record configured')
    return
  }
  presentation.log(`pushed ${result.pushed}, failed ${result.failed}, pending ${result.pending}`)
  if (result.retired) presentation.log(`retired ${result.retired} direct-write outbox rows`)
  if (result.routingPool) presentation.log(routingPoolLine(result.routingPool))
  logProjectRegister(result.projectRegister, presentation)
  logRecordCacheCounts(result, presentation)
  if (result.machineNameRefusal)
    presentation.log(`machine name not claimed: ${result.machineNameRefusal}`)
  for (const line of quarantinedOutboxLines(result.quarantined)) presentation.log(line)
  for (const line of blockedOutboxLines(result.blocked)) presentation.log(line)
  for (const line of readOnlyDeferredLines(result.readOnlyDeferred ?? [])) presentation.log(line)
  logHeldRows(result, presentation)
}
