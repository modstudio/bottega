// concern: monitor-types
/** Owns the plain data shapes shared by monitor composition, conditions, notices, and reporting. */

import type { MonitorSeverity } from '../review/review-vocabulary.ts'

export const MONITOR_NOTICE_DELIVERY_POLICY = {
  'abandoned-bootstrap': 'revalidated',
  'asking-run': 'revalidated',
  'dead-running-process': 'revalidated',
  'ghost-open-interval': 'append-only',
  idle: 'revalidated',
  'observation-error': 'append-only',
  'outbox-quarantined': 'revalidated',
  'outbox-retired-parent': 'revalidated',
  'stale-run': 'append-only',
  'stalled-run': 'revalidated',
  'task-waiting-on-ruling': 'revalidated',
  'terminal-close-out-failed': 'revalidated',
  'terminal-close-out-held': 'revalidated',
  'unscored-run': 'revalidated',
  'worker-gate-tooling-change': 'append-only',
} as const satisfies Record<string, 'append-only' | 'revalidated'>

export type MonitorNoticeKind = keyof typeof MONITOR_NOTICE_DELIVERY_POLICY

type MonitorConditionFields = {
  kind: string
  subject: string
  since: string | null
  ageMs: number | null
  detail: string
  action: string
  issueKey?: string | null
  affectedProject?: string
  severity?: MonitorSeverity | null
}

export type AddressedMonitorCondition = MonitorConditionFields & {
  kind: MonitorNoticeKind
  ownerSession: string | null
}

export type UnaddressedMonitorCondition = MonitorConditionFields & {
  kind: string
  ownerSession?: never
}

export type MonitorCondition = AddressedMonitorCondition | UnaddressedMonitorCondition

export type MonitorResult = {
  id: number
  startedAt: string
  finishedAt: string
  trigger: 'invoked' | 'backstop'
  conditions: MonitorCondition[]
  errors: string[]
  canon: { findings: number; docs: number }
}

export type MonitorNotice = Omit<MonitorCondition, 'detail' | 'action'> & {
  noticeId: `condition:${number}` | `landing:${number}` | `board:${number}`
  detail: string
}

/** Exactly the fields the human pass line prints, taken from the domain type. */
export type HumanMonitorCondition = Pick<
  MonitorCondition,
  'kind' | 'subject' | 'ageMs' | 'detail' | 'action' | 'issueKey' | 'severity' | 'ownerSession'
>

export type MonitorHistoryRow = {
  id: number
  started_at: string
  trigger: string
  findings: number
  errors: number
  conditions: unknown[]
}
