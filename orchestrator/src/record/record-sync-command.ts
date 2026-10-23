// concern: record-sync-command
/** Owns sync command presentation. Must not know record schema or run execution. */
import { readMachineValue } from '../../../shared/machine-config.ts'
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

export async function syncCommand(
  options: { backfill: boolean },
  presentation: { log(value: string): void },
): Promise<void> {
  let result: Awaited<ReturnType<typeof syncRecord>>
  try {
    result = await syncRecord({ backfill: options.backfill })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const enhanced = recordTunnelFailure(message, readMachineValue('record.tunnel_app'))
    if (enhanced === message) throw error
    throw new Error(enhanced, { cause: error })
  }
  if (result.backfill) {
    presentation.log(
      `backfill enqueued ${result.backfill.enqueued}, refreshed-roots ${result.backfill.refreshedRoots}, skipped-live ${result.backfill.skippedLive}`,
    )
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
  for (const line of quarantinedOutboxLines(result.quarantined)) presentation.log(line)
  for (const line of blockedOutboxLines(result.blocked)) presentation.log(line)
  for (const line of readOnlyDeferredLines(result.readOnlyDeferred ?? [])) presentation.log(line)
  for (const line of heldOutboxLines(result.held ?? [])) presentation.log(line)
}
