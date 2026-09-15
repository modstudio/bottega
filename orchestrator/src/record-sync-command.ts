// concern: record-sync-command
/** Owns sync command presentation. Must not know record schema or run execution. */
import { syncRecord } from './record-sync.ts'

export async function syncCommand(presentation: { log(value: string): void }): Promise<void> {
  const result = await syncRecord()
  if (!result.configured) {
    presentation.log('no record configured')
    return
  }
  presentation.log(`pushed ${result.pushed}, failed ${result.failed}, pending ${result.pending}`)
}
