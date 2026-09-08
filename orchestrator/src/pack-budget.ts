/**
 * Always-on canon ceilings. A breach is answered by demoting content to
 * on-demand, never by raising the number.
 */
export const DEFAULT_PACK_BYTES = 64 * 1024

/** A single injected document should remain a rule-sized unit. */
export const MAX_INJECT_DOC_BYTES = 8 * 1024
