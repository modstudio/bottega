// concern: canon-budget
/**
 * Canon is measured in bytes, not lines. A breach is answered by moving content
 * down a tier, never by raising a number.
 */
export const ENTRY_BYTES = 16 * 1024
export const ALWAYS_ON_TOTAL_BYTES = 32 * 1024
export const RULE_BYTES = 8 * 1024
export const CONTEXT_BYTES = 16 * 1024
export const REFERENCE_BYTES = 16 * 1024
export const CARD_BYTES = 2 * 1024
export const CHAIN_BYTES = 32 * 1024
