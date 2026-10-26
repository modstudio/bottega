import {
  DELEGATION_CLASSES,
  DELEGATION_SETTING_KEYS,
  type DelegationSettings,
  delegationClass,
} from '../../../shared/delegation-mode.ts'
import type { Job } from '../jobs/jobs.ts'

export function delegationDoctorLines(
  settings: DelegationSettings,
  jobs: readonly Job[],
  candidates: (job: string) => readonly { eligible: boolean }[],
): string[] {
  return DELEGATION_CLASSES.map((jobClass) => {
    const key = DELEGATION_SETTING_KEYS[jobClass]
    const mode = settings[key]
    if (mode === 'harness') return `${key} harness`
    const classJobs = jobs.filter((job) => delegationClass(job.needs) === jobClass)
    const eligible = classJobs.some((job) => candidates(job.name).some((agent) => agent.eligible))
    return `${key} external — eligible agent ${eligible ? 'yes' : 'NO'}`
  })
}
