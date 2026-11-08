/** Defers best-effort hosted-call observations so they never affect the observed request. */
export function scheduleHostedCallObservation<T>(
  recorder: ((observation: T) => void | Promise<void>) | undefined,
  observation: T,
): void {
  if (!recorder) return
  setTimeout(() => {
    try {
      void Promise.resolve(recorder(observation)).catch(() => {})
    } catch {
      // Best effort: read-only commands and recorder failures leave no observation.
    }
  }, 0)
}
