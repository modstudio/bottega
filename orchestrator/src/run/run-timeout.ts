import type { Agent } from '../agent/agents.ts'
import { type Job, resolveJobTimeoutMs } from '../jobs/jobs.ts'
import { recordRunStartupFailure } from './run-startup-failure.ts'

export function resolveRunBound(
  requestedJob: Job,
  agent: Agent,
  timeoutMinutes: number | undefined,
  reserveId: string | undefined,
): number {
  try {
    return resolveJobTimeoutMs(
      requestedJob,
      agent.timeoutMs ?? requestedJob.timeoutCeilingMs ?? 20 * 60_000,
      timeoutMinutes,
    )
  } catch (error) {
    recordRunStartupFailure(reserveId, error)
    throw error
  }
}
