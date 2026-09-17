import { useCallback, useState } from 'react'

/**
 * A per-browser preference. Storage can be missing or refuse writes, so the
 * value falls back to the default and a failed write keeps the in-memory value.
 */
export function useStoredState<T extends string>(key: string, fallback: T, allowed: readonly T[]) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key)
      return allowed.includes(stored as T) ? (stored as T) : fallback
    } catch {
      return fallback
    }
  })
  const update = useCallback(
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, next)
      } catch {}
    },
    [key],
  )
  return [value, update] as const
}
