// concern: monitor-types
/** Owns the plain data shapes shared by monitor composition, conditions, notices, and reporting. */

import type { MonitorSeverity } from '../review-vocabulary.ts'

export type MonitorCondition = {
  kind: string
  subject: string
  since: string | null
  ageMs: number | null
  detail: string
  action: string
  issueKey?: string | null
  affectedProject?: string
  severity?: MonitorSeverity | null
  ownerSession?: string | null
}

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
  noticeId: `condition:${number}` | `landing:${number}`
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
