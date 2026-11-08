// concern: session-liveness
/** Shared session-liveness window, independent of any local or hosted store. */

/**
 * A session seen inside this window is known live. A session outside it is
 * UNKNOWN, not dead: this row records orchestrator activity, not the owning process.
 * Silence therefore never transfers its authority to another session. A provably dead owner
 * process transfers authority only after every stored process not shared with the actor is gone
 * or reused and this live window has elapsed.
 */
export const SESSION_LIVE_MS = 60 * 60 * 1000
