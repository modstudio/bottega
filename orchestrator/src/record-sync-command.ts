// concern: record-sync-command
/** Owns sync command presentation. Must not know record schema or run execution. */
import { syncRecord } from './record-sync.ts'

export async function syncCommand(
  options: { backfill: boolean },
  presentation: { log(value: string): void },
): Promise<void> {
  const result = await syncRecord({ backfill: options.backfill })
  if (result.backfill) {
    presentation.log(
      `backfill minted ${result.backfill.minted}, enqueued ${result.backfill.enqueued}, skipped-live ${result.backfill.skippedLive}`,
    )
    presentation.log(
      `review backfill minted ${result.backfill.reviews.mintedReviews} reviews, ${result.backfill.reviews.mintedLenses} lenses, ${result.backfill.reviews.mintedFindings} findings; enqueued ${result.backfill.reviews.enqueuedReviews} reviews`,
    )
  }
  if (!result.configured) {
    presentation.log('no record configured')
    return
  }
  presentation.log(`pushed ${result.pushed}, failed ${result.failed}, pending ${result.pending}`)
}
