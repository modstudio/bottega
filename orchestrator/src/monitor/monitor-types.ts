// concern: monitor-types
/** Owns the plain data shapes shared by monitor composition, conditions, notices, and reporting. */

import type { HostLoadSample } from '../host-load-sample.ts'
import type { MonitorSeverity } from '../review/review-vocabulary.ts'
import type { RunHostCapacityQueue } from '../run/run-host-capacity.ts'
import type { HostAdmissionSummary } from './host-admission-summary.ts'

export type MonitorHostLoad = HostLoadSample
export type MonitorHostPressure = {
  available: boolean
  error: string | null
  memoryPressure: string | null
  attributions: { owner: string; project: string | null; cpu: number; share: number }[]
  averageObservationElapsedMs: number | null
  averageObservationCpuMs: number | null
}

export type HostPressureConditionDetail = {
  processes: { pid: number; cpu: number; command: string }[]
  ownerName: string
  project: string | null
  share: number
  cpu: number
  loadavg: number
  ncpu: number
  waiting: string[]
  ownerSession: string | null
}

export const MONITOR_NOTICE_DELIVERY_POLICY = {
  'abandoned-bootstrap': 'revalidated',
  'asking-run': 'revalidated',
  'dead-running-process': 'revalidated',
  'ghost-open-interval': 'append-only',
  'host-pressure': 'append-only',
  idle: 'revalidated',
  'observation-error': 'append-only',
  'outbox-quarantined': 'revalidated',
  'outbox-held-for-upgrade': 'revalidated',
  'outbox-quarantined-parent': 'revalidated',
  'outbox-retired-parent': 'revalidated',
  'stale-run': 'append-only',
  'stalled-run': 'revalidated',
  'stuck-host-wait': 'revalidated',
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
  hostPressureDetail?: HostPressureConditionDetail
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

export type RecipeDatabaseNamespace = {
  project: string
  allocationKey: string
  engine: 'postgres' | 'mysql' | 'mariadb'
  names: string[]
  sourceName: string
  mainName: string | null
}

export type RecipeDatabaseClaim = { allocationKey: string; state: string }

export type MonitorResult = {
  /** The monitor invocation's display number. */
  id: number
  startedAt: string
  finishedAt: string
  trigger: 'invoked' | 'backstop'
  conditions: MonitorCondition[]
  errors: string[]
  canon: { findings: number; docs: number }
  hostLoad: MonitorHostLoad
  hostPressure: MonitorHostPressure
  runHostCapacity: RunHostCapacityQueue
  hostAdmissions: HostAdmissionSummary
}

export type MonitorNotice = Omit<MonitorCondition, 'detail' | 'action'> & {
  noticeId: `condition:${number}` | `landing:${string}` | `board:${string}`
  label: string
  detail: string
}

/** Exactly the fields the human pass line prints, taken from the domain type. */
export type HumanMonitorCondition = Pick<
  MonitorCondition,
  'kind' | 'subject' | 'ageMs' | 'detail' | 'action' | 'issueKey' | 'severity' | 'ownerSession'
>

export type MonitorHistoryRow = {
  record_id: string
  /** The monitor invocation's display number. */
  id: number
  started_at: string
  trigger: string
  findings: number
  errors: number
  conditions: unknown[]
  host_load: MonitorHostLoad | null
}
