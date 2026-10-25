// concern: score
/** Owns the declared jobs whose verdicts take a fidelity axis. */

export const WRITING_JOB_NAMES = ['fix', 'implement', 'issue-worker'] as const

/** Whether the scorer requires a fidelity axis for this declared job. */
export function jobTakesFidelity(jobName: string): boolean {
  return (WRITING_JOB_NAMES as readonly string[]).includes(jobName)
}

export function writingJobNeeds(jobName: (typeof WRITING_JOB_NAMES)[number]) {
  if (!jobTakesFidelity(jobName)) throw new Error(`job ${jobName} does not take fidelity`)
  return { readsRepo: true, writesRepo: true, resumable: true } as const
}
