// concern: record-api-client-moderation
/** Owns hosted moderation hide requests. */

import type { ModerationHideReason } from '../../../shared/moderation-hide-reason.ts'
import type { RecordClientRequest } from './record-api-client-paths.ts'
import type { HiddenRow } from './record-moderation-hide.ts'

export function recordModerationClient(request: RecordClientRequest) {
  return {
    hideRow: (input: { message?: string; note?: string; reason: ModerationHideReason }) =>
      request<{ hidden: HiddenRow }>('/v1/moderation/hide', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    unhideRow: (input: { message?: string; note?: string }) =>
      request<{ unhidden: true }>('/v1/moderation/unhide', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    listHidden: () => request<{ hidden: HiddenRow[] }>('/v1/moderation/hidden'),
  }
}
