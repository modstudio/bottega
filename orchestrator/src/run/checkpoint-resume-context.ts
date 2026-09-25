// concern: checkpoint-resume-context
/** Renders checkpoint provenance without deciding which commit the resumed tree exposes. */

export type CheckpointResumeValues = {
  startCommit: string
  branch: string
  checkpoint: {
    commit_sha: string
    checkpoint_no: number
    task_pointer: string | null
  } | null
  recentLog: string
}

export function renderCheckpointResumeContext(input: CheckpointResumeValues): string | null {
  if (!input.checkpoint) return null
  const checkpointAtStart = input.checkpoint.commit_sha === input.startCommit
  return [
    'CHECKPOINT RESUME',
    checkpointAtStart
      ? `Resume at ${input.startCommit} on ${input.branch} (checkpoint #${input.checkpoint.checkpoint_no}).`
      : `Resume at ${input.startCommit} on ${input.branch}.`,
    checkpointAtStart
      ? null
      : `Latest harness checkpoint #${input.checkpoint.checkpoint_no} at ${input.checkpoint.commit_sha} is earlier than the start commit and is provenance, not the tree state.`,
    input.checkpoint.task_pointer ? `Last completed item: ${input.checkpoint.task_pointer}` : null,
    input.recentLog ? `Recent branch history:\n${input.recentLog}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}
