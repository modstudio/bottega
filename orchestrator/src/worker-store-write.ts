// concern: worker store write authority
/** Pure worker-run refusal for shared text stores. Must not know commands, stores, or processes. */

export type WorkerMarkers = Readonly<Record<string, string | undefined>>

export type SharedTextStore = 'document' | 'workflow' | 'port'

export function workerStoreWriteRefusal(
  store: SharedTextStore,
  command: string,
  env: WorkerMarkers,
): string | null {
  if (!env.BOTTEGA_RUN_ID && !env.BOTTEGA_DEPTH) return null
  return (
    `refusing ${store} store write from an orchestrator worker run: ${command}\n` +
    'condition: BOTTEGA_RUN_ID or BOTTEGA_DEPTH marks this process as a worker run\n' +
    'remedy: write the intended hydrated file in your tree when the store has one, state the ' +
    'exact store change in your reply, and let the architect apply it after review and before the final gate'
  )
}
