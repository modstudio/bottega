// concern: review-lens-input-artifact
/** Persists dispatch-only lens input facts until the review row is recorded. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ReviewLensInputStatuses = {
  taskTextInput: ReviewLensInputStatus
  rulingsInput: ReviewLensInputStatus | null
}

export type ReviewLensInputStatus = 'carried' | `unavailable: ${string}`
export type ReviewLensInputArtifactRead =
  | { outcome: 'absent' }
  | { outcome: 'unreadable' }
  | ({ outcome: 'statuses' } & ReviewLensInputStatuses)

const UNAVAILABLE_PREFIX = 'unavailable:'

export const unavailableStatus = (reason: string): ReviewLensInputStatus =>
  `${UNAVAILABLE_PREFIX} ${reason}`

export function unavailableReason(status: ReviewLensInputStatus | null | undefined): string | null {
  if (!status?.startsWith(UNAVAILABLE_PREFIX)) return null
  return status.slice(UNAVAILABLE_PREFIX.length).trim() || 'reason not recorded'
}

function inputStatus(value: unknown): ReviewLensInputStatus | null {
  if (value === 'carried') return value
  if (typeof value !== 'string') return null
  return unavailableReason(value as ReviewLensInputStatus) ? (value as ReviewLensInputStatus) : null
}

const artifactPath = (promptPath: string): string =>
  join(dirname(promptPath), 'review-lens-inputs.json')

export function writeReviewLensInputArtifact(
  promptPath: string,
  statuses: ReviewLensInputStatuses,
): void {
  writeFileSync(artifactPath(promptPath), `${JSON.stringify(statuses)}\n`)
}

export function readReviewLensInputArtifact(
  promptPath: string | null,
): ReviewLensInputArtifactRead {
  if (!promptPath || !existsSync(artifactPath(promptPath))) {
    return { outcome: 'absent' }
  }
  try {
    const parsed = JSON.parse(readFileSync(artifactPath(promptPath), 'utf8')) as Record<
      string,
      unknown
    >
    const taskTextInput = inputStatus(parsed.taskTextInput)
    const rulingsInput = parsed.rulingsInput === null ? null : inputStatus(parsed.rulingsInput)
    if (!taskTextInput || (parsed.rulingsInput !== null && !rulingsInput)) {
      return { outcome: 'unreadable' }
    }
    return { outcome: 'statuses', taskTextInput, rulingsInput }
  } catch {
    return { outcome: 'unreadable' }
  }
}

/** Preserve predecessor input facts while making missing or corrupt facts explicitly unavailable. */
export function successorReviewLensInputStatuses(
  read: ReviewLensInputArtifactRead,
): ReviewLensInputStatuses {
  if (read.outcome === 'statuses') {
    return { taskTextInput: read.taskTextInput, rulingsInput: read.rulingsInput }
  }
  const reason =
    read.outcome === 'absent'
      ? 'input statuses were not carried to this run'
      : 'input statuses could not be read'
  const status = unavailableStatus(reason)
  return { taskTextInput: status, rulingsInput: status }
}

export const successorReviewLensInputStatusesFromPrompt = (
  promptPath: string | null,
): ReviewLensInputStatuses =>
  successorReviewLensInputStatuses(readReviewLensInputArtifact(promptPath))
