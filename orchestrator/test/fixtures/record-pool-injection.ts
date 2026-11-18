import type { SQL } from 'bun'

const RECORD_POOL_SLOT = Symbol.for('orch.record-pool')

function slot(): Map<string, SQL> {
  const holder = globalThis as typeof globalThis & {
    [key: symbol]: Map<string, SQL> | undefined
  }
  return (holder[RECORD_POOL_SLOT] ??= new Map())
}

export function installRecordPool(url: string, sql: SQL): () => void {
  const pools = slot()
  const previous = pools.get(url)
  pools.set(url, sql)
  return () => {
    if (previous) pools.set(url, previous)
    else pools.delete(url)
  }
}
