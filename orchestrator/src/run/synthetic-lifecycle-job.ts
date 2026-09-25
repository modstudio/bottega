// concern: run
/** Identifies local synthetic rows that own architect-managed tree lifecycles. */

export const HOOK_TREE_JOB = 'hook-tree'
export const LANDING_TREE_JOB = 'landing-tree'
export const SYNTHETIC_LIFECYCLE_JOBS = [HOOK_TREE_JOB, LANDING_TREE_JOB] as const

export function isSyntheticLifecycleJob(job: string): boolean {
  return (SYNTHETIC_LIFECYCLE_JOBS as readonly string[]).includes(job)
}

export function agentWorkValue<T>(job: string, value: () => T): T | null {
  return isSyntheticLifecycleJob(job) ? null : value()
}

export function assertAgentWorkRun(
  id: number,
  job: string,
  action: 'judged' | 'retried' | 'scored' | 'unvoided',
): void {
  if (!isSyntheticLifecycleJob(job)) return
  throw new Error(
    `run ${id} is a lifecycle row, not agent work; it cannot be ${action}. No action is needed because lifecycle rows are evidence-excluded`,
  )
}

/** Synthetic lifecycle rows are not agent executions and never enter agent-work statistics. */
export function agentExecutionStatsSql(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('run alias must be a SQL identifier')
  return `${alias}.job NOT IN ('${SYNTHETIC_LIFECYCLE_JOBS.join("','")}')`
}
