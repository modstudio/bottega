// concern: identity-session-events
/** Key classifications shared by machine-local and hosted session event tables. */

import type { ManifestColumn } from './identity-inventory.ts'

const manifest = (store: 'orchestrator' | 'hosted', reason: string, columns: string[]) =>
  columns.map((column): ManifestColumn => ({ store, column, reason }))

export const SESSION_EVENT_IDENTITY = {
  values: [
    ...manifest('orchestrator', 'count, ordinal, version, handle, or measurement', [
      'brief_injection.bytes',
      'brief_injection.lines',
      'brief_injection.cursors',
      'brief_injection.keyless_cursors',
      'brief_injection.keyless_idle_max_ms',
      'context_review.interval_ms',
      'context_review.items',
      'context_review.flagged',
      'hook_emission.chars',
      'hook_emission.lines',
    ]),
    ...manifest('hosted', 'count, ordinal, version, handle, or measurement', [
      'brief_injection.bytes',
      'brief_injection.lines',
      'brief_injection.cursors',
      'brief_injection.keyless_cursors',
      'brief_injection.keyless_idle_max_ms',
      'context_review.interval_ms',
      'context_review.items',
      'context_review.flagged',
    ]),
  ],
  externalIdentifiers: [
    ...manifest('orchestrator', 'identifier issued by the harness session system', [
      'brief_injection.session_id',
      'context_review.session_id',
      'hook_emission.session_id',
    ]),
    ...manifest('hosted', 'identifier issued by the harness session system', [
      'brief_injection.session_id',
      'context_review.session_id',
      'hook_emission.session_id',
    ]),
  ],
  uuids: [
    ...manifest('orchestrator', 'owned or referenced UUID', [
      'brief_injection.record_id',
      'context_review.record_id',
      'context_review.item_ids',
      'hook_emission.record_id',
    ]),
    ...manifest('hosted', 'owned or referenced UUID', ['context_review.item_ids']),
  ],
} as const
