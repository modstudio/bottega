// concern: pure refusal for findings close-out flags
/** Knows which findings close-out flags a job and delivery accept. Must not know runs, stores, review evidence, or transports. */

export function findingsCloseOutRefusal(input: {
  runId: string
  jobName: string
  findingsJob: boolean
  delivery: string | undefined
  suppliedFlags: readonly string[]
}): string | null {
  if (input.suppliedFlags.length === 0) return null
  const namedFlags = input.suppliedFlags.map((name) => `--${name}`).join(', ')
  if (!input.findingsJob) {
    return `${input.jobName} is not a findings-producing lens and does not take findings close-out flags (${namedFlags})`
  }
  if (input.delivery === 'none') {
    return `${input.jobName} run ${input.runId} was scored delivery none, which takes no findings or review grades (${namedFlags}); if the lens delivered a review, score its delivery partial or full and grade it; otherwise drop these flags and put the facts in --note`
  }
  return null
}
