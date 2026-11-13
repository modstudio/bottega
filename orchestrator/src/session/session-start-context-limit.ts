// concern: session-start-context-limit
/** Exposes the harness SessionStart context cap from the hook-owned declaration. */

import limits from '../../hooks/session-start-context.json'

export const SESSION_START_CONTEXT_MAX_CHARS = limits.SESSION_START_CONTEXT_MAX_CHARS
