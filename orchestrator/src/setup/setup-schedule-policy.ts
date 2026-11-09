// concern: setup-schedule-policy
/** Pure maintenance-schedule identities, rendering, and setup-level rulings. */

import { renderLaunchAgentTemplate } from '../../../shared/launch-agent-render.ts'
import {
  type LaunchAgentSkipFacts,
  launchAgentSkipReason,
} from '../../../shared/launch-agent-skip.ts'
import type { MachineLevel } from '../../../shared/machine-config.ts'
import {
  RECORD_SYNC_PENDING_MARKER,
  recordSyncQueueDirectory,
  STATE_HOME_ENV,
} from '../../../shared/state-directory.ts'

export const MAINTENANCE_SCHEDULE_LABELS = [
  'com.user.orch-sweep',
  'com.user.orch-record-sync',
] as const

export type MaintenanceScheduleLabel = (typeof MAINTENANCE_SCHEDULE_LABELS)[number]

const maintenanceScheduleLabels = new Set<string>(MAINTENANCE_SCHEDULE_LABELS)

export function isMaintenanceScheduleLabel(label: string): label is MaintenanceScheduleLabel {
  return maintenanceScheduleLabels.has(label)
}

export type ScheduleSetupFact = {
  label: MaintenanceScheduleLabel
  installed: boolean
  loaded: boolean
  definitionMatches: boolean
}

export type ScheduleRenderValues = {
  bottegaBin: string
  home: string
  stateHomeEnvironment: string
  stateHome: string
}

export const MAINTENANCE_SCHEDULE_PLACEHOLDERS = [
  '__BOTTEGA_BIN__',
  '__HOME__',
  '__STATE_HOME_ENV__',
  '__STATE_HOME__',
  '__RECORD_SYNC_QUEUE__',
  '__RECORD_SYNC_MARKER__',
] as const

export type ScheduleApplyResult = {
  label: MaintenanceScheduleLabel
  status: 'applied' | 'unchanged' | 'skipped'
  reason?: string
}

export type MaintenanceSchedulePlanItem = {
  label: MaintenanceScheduleLabel
  skipReason: string | null
}

/** Apply the shared skip ruling to the canonical setup label set. */
export function maintenanceSchedulePlan(
  skipFacts: LaunchAgentSkipFacts,
): MaintenanceSchedulePlanItem[] {
  return MAINTENANCE_SCHEDULE_LABELS.map((label) => ({
    label,
    skipReason: launchAgentSkipReason(label, skipFacts),
  }))
}

/** Return the release-owned schedules required at this machine's setup level. */
export function requiredMaintenanceLabels(
  skipFacts: LaunchAgentSkipFacts,
  level: MachineLevel,
): MaintenanceScheduleLabel[] {
  if (level !== 'full') return []
  return maintenanceSchedulePlan(skipFacts).flatMap(({ label, skipReason }) =>
    skipReason ? [] : [label],
  )
}

/** Replace the complete placeholder vocabulary shared by maintenance definitions. */
export function renderMaintenanceSchedule(template: string, values: ScheduleRenderValues): string {
  const recordSyncQueue = recordSyncQueueDirectory({ [STATE_HOME_ENV]: values.stateHome })
  return renderLaunchAgentTemplate(template, {
    __BOTTEGA_BIN__: values.bottegaBin,
    __HOME__: values.home,
    __STATE_HOME_ENV__: values.stateHomeEnvironment,
    __STATE_HOME__: values.stateHome,
    __RECORD_SYNC_QUEUE__: recordSyncQueue,
    __RECORD_SYNC_MARKER__: RECORD_SYNC_PENDING_MARKER,
  })
}
