// concern: score
/**
 * Owns the declared jobs whose verdicts take a fidelity axis. It mirrors the
 * `writesRepo` declarations in `JOBS` without importing them, so collection's
 * small import graph stays free of the job table; `refusal-guidance.test.ts`
 * pins the two together.
 */

export const WRITING_JOB_NAMES = ['fix', 'implement', 'issue-worker'] as const

/** Whether the scorer requires a fidelity axis for this declared job. */
export function jobTakesFidelity(jobName: string): boolean {
  return (WRITING_JOB_NAMES as readonly string[]).includes(jobName)
}
