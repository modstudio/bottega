// concern: process-memo
/** Shares one asynchronously loaded value within a process for a bounded time. */

type ProcessMemoOptions<T> = {
  maxAgeMs: number
  keep?: (value: T) => boolean
  now?: () => number
}

type MemoEntry<T> = {
  startedAt: number
  load: Promise<T>
  settled: boolean
}

export function processMemo<T>(
  load: () => Promise<T>,
  options: ProcessMemoOptions<T>,
): { get(): Promise<T>; clear(): void } {
  const now = options.now ?? Date.now
  const keep = options.keep ?? (() => true)
  let entry: MemoEntry<T> | undefined

  return {
    get(): Promise<T> {
      const startedAt = now()
      if (entry && (!entry.settled || startedAt - entry.startedAt < options.maxAgeMs))
        return entry.load

      let next!: MemoEntry<T>
      const pending = load().then(
        (value) => {
          next.settled = true
          if (!keep(value) && entry === next) entry = undefined
          return value
        },
        (error) => {
          if (entry === next) entry = undefined
          throw error
        },
      )
      next = { startedAt, settled: false, load: pending }
      entry = next
      return pending
    },
    clear(): void {
      entry = undefined
    },
  }
}
