// concern: session close-out report
/** Shared report shapes for session close-out and its context lifecycle component. */

export type SessionProcessItem = { item: string; reason: string; evidence: string; remedy: string }
export type SessionErrorItem = { item: string; detail: string; retry: string }
