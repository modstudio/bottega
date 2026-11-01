// concern: pull-request post-landing hand-off
/** Identity fixed by the parent before the main checkout moves. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export const POST_LANDING_FLAG = '--post-landing'

export function postLandingRecovery(target: string): string {
  return `recover with: ${PLATFORM_SLUG} machine update (or ${PLATFORM_SLUG} machine migrate when no runs are in flight), then ${PLATFORM_SLUG} pr merge ${target} --release-required`
}

export type PullRequestPostLandingPayload = {
  project: string
  target: string
  prNumber: number
  headBranch: string
  headCommit: string
  mergeCommit: string
  requiredRungs: string[]
  rungDecisionError: string | null
  releaseRequired: boolean
  promoteWorkflowDrafts: boolean
  recordingError: string | null
  requeueOutput: string | null
}

export function encodePullRequestPostLandingPayload(
  payload: PullRequestPostLandingPayload,
): string {
  return JSON.stringify(payload)
}

const PREFIX = 'refusing a pull-request post-landing payload: '
const REMEDY = `; rerun the original ${PLATFORM_SLUG} pr merge command`

function refusal(field: string, expected: string): Error {
  return new Error(`${PREFIX}${field} must be ${expected}${REMEDY}`)
}

export function parsePullRequestPostLandingPayload(text: string): PullRequestPostLandingPayload {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${PREFIX}it is not JSON${REMEDY}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw refusal('the payload', 'an object')
  const row = value as Record<string, unknown>
  for (const field of ['project', 'target', 'headBranch', 'headCommit', 'mergeCommit'] as const) {
    if (typeof row[field] !== 'string' || !row[field]) throw refusal(field, 'a non-empty string')
  }
  if (!Number.isSafeInteger(row.prNumber) || Number(row.prNumber) <= 0)
    throw refusal('prNumber', 'a positive integer')
  if (
    !Array.isArray(row.requiredRungs) ||
    row.requiredRungs.some((rung) => typeof rung !== 'string' || !rung)
  )
    throw refusal('requiredRungs', 'an array of non-empty strings')
  if (!(row.rungDecisionError === null || typeof row.rungDecisionError === 'string'))
    throw refusal('rungDecisionError', 'a string or null')
  if (typeof row.releaseRequired !== 'boolean') throw refusal('releaseRequired', 'a boolean')
  if (typeof row.promoteWorkflowDrafts !== 'boolean')
    throw refusal('promoteWorkflowDrafts', 'a boolean')
  if (!(row.recordingError === null || typeof row.recordingError === 'string'))
    throw refusal('recordingError', 'a string or null')
  if (!(row.requeueOutput === null || typeof row.requeueOutput === 'string'))
    throw refusal('requeueOutput', 'a string or null')
  return row as PullRequestPostLandingPayload
}
