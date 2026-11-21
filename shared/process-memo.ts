// concern: process-memo
/** Shares one asynchronously loaded value within a process for a bounded time. */

type ProcessMemoOptions = {
  maxAgeMs: number
  now?: () => number
}

type MemoEntry<T> = {
  startedAt: number
  load: Promise<T>
  settled: boolean
  value?: T
}

type ProcessMemo<T> = {
  get(): Promise<T>
  clearIf(predicate: (value: T) => boolean): void
}

export function processMemo<T>(
  load: () => Promise<T>,
  options: ProcessMemoOptions,
): ProcessMemo<T> {
  const now = options.now ?? Date.now
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
          next.value = value
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
    clearIf(predicate: (value: T) => boolean): void {
      if (entry?.settled && predicate(entry.value as T)) entry = undefined
    },
  }
}
