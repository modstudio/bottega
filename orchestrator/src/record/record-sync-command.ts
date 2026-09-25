// concern: record-sync-command
/** Owns sync command presentation. Must not know record schema or run execution. */
import { readMachineValue } from '../../../shared/machine-config.ts'
import { syncRecord } from './record-sync.ts'
import { recordTunnelFailure } from './record-tunnel-error.ts'

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
      `backfill minted ${result.backfill.minted}, enqueued ${result.backfill.enqueued}, skipped-live ${result.backfill.skippedLive}`,
    )
    presentation.log(`score backfill enqueued ${result.backfill.scores}`)
    presentation.log(
      `review backfill minted ${result.backfill.reviews.mintedReviews} reviews, ${result.backfill.reviews.mintedLenses} lenses, ${result.backfill.reviews.mintedFindings} findings; enqueued ${result.backfill.reviews.enqueuedReviews} reviews`,
    )
    const evidence = result.backfill.landingEvidence
    presentation.log(
      `landing evidence backfill minted ${evidence.mintedLandings} landings, ${evidence.mintedOverrides} overrides, ${evidence.mintedCarries} carries, ${evidence.mintedContentions} contentions, ${evidence.mintedFlakes} flakes; enqueued ${evidence.enqueuedLandings}, ${evidence.enqueuedOverrides}, ${evidence.enqueuedCarries}, ${evidence.enqueuedContentions}, ${evidence.enqueuedFlakes}`,
    )
  }
  if (!result.configured) {
    presentation.log('no record configured')
    return
  }
  presentation.log(`pushed ${result.pushed}, failed ${result.failed}, pending ${result.pending}`)
}
