/**
 * The compiled worker pack (always-on canon, the context index, and inject
 * docs) is bounded by DEFAULT_PACK_BYTES. A breach is answered by demoting
 * the largest packed tier, never by raising the number.
 */
export const DEFAULT_PACK_BYTES = 64 * 1024

/** A single injected document should remain a rule-sized unit. */
export const MAX_INJECT_DOC_BYTES = 8 * 1024
