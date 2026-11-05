// concern: record-change-wake
/** Owns the lazy process-wide LISTEN connection shared by record-change waiters. */
import { SQL } from 'bun'
import { recordServiceUrl } from '../../../shared/record/service-connection.ts'

const RECORD_CHANGE_SAFETY_POLL_MS = 2_000
const RECORD_CHANGE_NOTIFY_CHANNEL = 'record_change_advanced'

type Listener = {
  listen(
    channel: string,
    notify: () => void,
    listening: () => void,
  ): Promise<{ unlisten(): Promise<void> }>
  close(): Promise<void>
}

export function createRecordChangeWakeSource(recordUrl: string, supplied?: Listener) {
  const waiters = new Set<() => void>()
  let client: Listener | undefined = supplied
  let opening: Promise<void> | undefined
  let subscription: { unlisten(): Promise<void> } | undefined
  const wake = () => {
    for (const waiter of waiters) waiter()
  }
  const open = () => {
    if (!opening)
      opening = (async () => {
        client ??= supplied ?? new SQL(recordServiceUrl(recordUrl))
        subscription = await client.listen(RECORD_CHANGE_NOTIFY_CHANNEL, wake, wake)
      })().catch((error) => {
        opening = undefined
        client = undefined
        throw error
      })
    return opening
  }
  return {
    async wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) return
      await open().catch(() => undefined)
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>
        const done = () => {
          waiters.delete(done)
          signal?.removeEventListener('abort', done)
          clearTimeout(timer)
          resolve()
        }
        waiters.add(done)
        signal?.addEventListener('abort', done, { once: true })
        timer = setTimeout(done, Math.min(milliseconds, RECORD_CHANGE_SAFETY_POLL_MS))
      })
    },
    async close() {
      wake()
      if (opening) await opening.catch(() => undefined)
      await subscription?.unlisten()
      await client?.close()
    },
  }
}
