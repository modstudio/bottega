// concern: run throttle cancellation
import type { StreamEvent } from '../events.ts'
import { composeCodexThrottleNotice } from '../transport/codex-throttle.ts'

type ThrottledEvent = Extract<StreamEvent, { kind: 'throttled' }>

export function firstThrottleObserver(cancel: () => void) {
  const state: { first: ThrottledEvent | null } = { first: null }
  return {
    state,
    observe(event: StreamEvent) {
      if (event.kind !== 'throttled' || state.first) return
      state.first = event
      cancel()
    },
  }
}

export function throttleReplyError(
  throttle: ThrottledEvent | null,
  replyError: string | null | undefined,
  collectedError: string | null,
): string | null {
  return throttle ? composeCodexThrottleNotice(throttle) : (replyError ?? collectedError)
}
