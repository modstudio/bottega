// concern: setup-schedule-runtime
/** Routes maintenance schedule facts and application to the host platform adapter. */

import { homedir } from 'node:os'
import { resolveStateRoot, STATE_HOME_ENV } from '../../../shared/state-directory.ts'
import {
  type ScheduleApplyResult,
  type ScheduleRenderValues,
  type ScheduleSetupFact,
  schedulePlatformSupported,
} from './setup-schedule-policy.ts'
import {
  applyLaunchdMaintenanceSchedules,
  gatherLaunchdScheduleSetupFacts,
} from './setup-schedules.ts'
import {
  applySystemdMaintenanceSchedules,
  gatherScheduleLingerFact as gatherSystemdScheduleLingerFact,
  gatherSystemdScheduleSetupFacts,
  gatherScheduleUserFact as gatherSystemdScheduleUserFact,
} from './setup-systemd-schedules.ts'

function scheduleValues(): ScheduleRenderValues {
  return {
    bottegaBin: process.execPath,
    home: homedir(),
    stateHomeEnvironment: STATE_HOME_ENV,
    stateHome: resolveStateRoot(process.env),
  }
}

export function gatherScheduleSetupFacts(): ScheduleSetupFact[] {
  if (!schedulePlatformSupported(process.platform)) return []
  const values = scheduleValues()
  switch (process.platform) {
    case 'darwin':
      return gatherLaunchdScheduleSetupFacts(values)
    case 'linux':
      return gatherSystemdScheduleSetupFacts(values)
    default:
      throw new Error(`maintenance schedule adapter missing for ${process.platform}`)
  }
}

export async function applyMaintenanceSchedules(): Promise<ScheduleApplyResult[]> {
  if (!schedulePlatformSupported(process.platform)) return []
  const values = scheduleValues()
  switch (process.platform) {
    case 'darwin':
      return applyLaunchdMaintenanceSchedules(values)
    case 'linux':
      return applySystemdMaintenanceSchedules(values)
    default:
      throw new Error(`maintenance schedule adapter missing for ${process.platform}`)
  }
}

export function gatherScheduleLingerFact(): boolean | null {
  return process.platform === 'linux' ? gatherSystemdScheduleLingerFact() : null
}

export function gatherScheduleUserFact(): string | null {
  return process.platform === 'linux' ? gatherSystemdScheduleUserFact() : null
}
