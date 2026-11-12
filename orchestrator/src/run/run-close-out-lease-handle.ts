// concern: asynchronous run close-out lease ownership
/** Acquires a close-out lease whose asynchronous owner releases it explicitly. */

import { releaseRunCloseOutLease, requiredRunCloseOutLease } from './run-lease.ts'

export function acquireRunCloseOutLeaseHandle(
  runId: string,
  failed: (cause: unknown) => void,
): () => void {
  const lease = requiredRunCloseOutLease(runId, failed)
  return () => releaseRunCloseOutLease(runId, lease)
}
