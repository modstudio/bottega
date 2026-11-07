// concern: review-lens-input-artifact
/** Persists dispatch-only lens input facts until the review row is recorded. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ReviewLensInputStatuses = {
  taskTextInput: string
  rulingsInput: string | null
}

const artifactPath = (promptPath: string): string =>
  join(dirname(promptPath), 'review-lens-inputs.json')

export function writeReviewLensInputArtifact(
  promptPath: string,
  statuses: ReviewLensInputStatuses,
): void {
  writeFileSync(artifactPath(promptPath), `${JSON.stringify(statuses)}\n`)
}

export function readReviewLensInputArtifact(promptPath: string | null): {
  taskTextInput: string | null
  rulingsInput: string | null
} {
  if (!promptPath || !existsSync(artifactPath(promptPath))) {
    return { taskTextInput: null, rulingsInput: null }
  }
  try {
    const parsed = JSON.parse(readFileSync(artifactPath(promptPath), 'utf8')) as Record<
      string,
      unknown
    >
    return {
      taskTextInput: typeof parsed.taskTextInput === 'string' ? parsed.taskTextInput : null,
      rulingsInput: typeof parsed.rulingsInput === 'string' ? parsed.rulingsInput : null,
    }
  } catch {
    return { taskTextInput: null, rulingsInput: null }
  }
}
