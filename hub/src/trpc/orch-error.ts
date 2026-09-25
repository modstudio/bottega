import { TRPCError } from '@trpc/server'

const staleDocumentMessage =
  'This document changed since you opened it. Reload to see the current version; your edit was not saved.'

export async function fromOrch<T>(
  operation: () => Promise<T>,
  classifyStaleRevision = false,
): Promise<T> {
  try {
    return await operation()
  } catch (cause) {
    const raw = cause instanceof Error ? cause.message : String(cause)
    const message = raw.replace(/^orch \S+ exited \d+:\s*/, '') || raw
    if (classifyStaleRevision && message.includes('refusing stale document update')) {
      throw new TRPCError({ code: 'CONFLICT', message: staleDocumentMessage, cause })
    }
    throw new TRPCError({ code: 'BAD_REQUEST', message, cause })
  }
}
