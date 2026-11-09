// concern: session close-out report
/** Shared report shapes for session close-out and its context lifecycle component. */

export type SessionProcessLine = { item: string; reason: string; evidence: string; remedy: string }
export type SessionErrorLine = { item: string; detail: string; retry: string }
