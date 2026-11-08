// concern: pull-request post-landing hand-off
/** Identity fixed by the parent before the main checkout moves. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { RELEASE_REQUIREMENT_SOURCES, type ReleaseRungPlan } from '../release/release-required.ts'
import { releaseDepthFlag } from '../release/ship-to-reach.ts'

export const POST_LANDING_FLAG = '--post-landing'

export function requiredMergeCommand(target: string, depth?: string | null): string {
  return `${PLATFORM_SLUG} pr merge ${target} --release-required${releaseDepthFlag(depth)}`
}

export function postLandingRecovery(target: string, depth?: string | null): string {
  return `recover with: ${PLATFORM_SLUG} machine update (or ${PLATFORM_SLUG} machine migrate when no runs are in flight), then ${requiredMergeCommand(target, depth)}`
}

export type PullRequestPostLandingPayload = {
  project: string
  target: string
  prNumber: number
  headBranch: string
  headCommit: string
  mergeCommit: string
  requiredRungs: string[]
  rungPlans?: ReleaseRungPlan[]
  rungDecisionError: string | null
  releaseRequired: boolean
  depth: string | null
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

function validRungPlans(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.every((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
      return false
    const plan = candidate as Record<string, unknown>
    return (
      typeof plan.rung === 'string' &&
      Boolean(plan.rung) &&
      typeof plan.branch === 'string' &&
      Boolean(plan.branch) &&
      typeof plan.required === 'boolean' &&
      (plan.requiredBy === null ||
        RELEASE_REQUIREMENT_SOURCES.includes(
          plan.requiredBy as (typeof RELEASE_REQUIREMENT_SOURCES)[number],
        )) &&
      (plan.reason === null || typeof plan.reason === 'string') &&
      typeof plan.declaresLive === 'boolean' &&
      typeof plan.declaresDeploy === 'boolean'
    )
  })
}

function validateRungPlans(value: unknown): void {
  if (value !== undefined && !validRungPlans(value))
    throw refusal('rungPlans', 'an array of release-rung plans')
}

function validateDepth(value: unknown): string | null {
  if (value === undefined) return null
  if (!(value === null || (typeof value === 'string' && value)))
    throw refusal('depth', 'a non-empty string or null')
  return value
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
  validateRungPlans(row.rungPlans)
  if (!(row.rungDecisionError === null || typeof row.rungDecisionError === 'string'))
    throw refusal('rungDecisionError', 'a string or null')
  if (typeof row.releaseRequired !== 'boolean') throw refusal('releaseRequired', 'a boolean')
  row.depth = validateDepth(row.depth)
  if (typeof row.promoteWorkflowDrafts !== 'boolean')
    throw refusal('promoteWorkflowDrafts', 'a boolean')
  if (!(row.recordingError === null || typeof row.recordingError === 'string'))
    throw refusal('recordingError', 'a string or null')
  if (!(row.requeueOutput === null || typeof row.requeueOutput === 'string'))
    throw refusal('requeueOutput', 'a string or null')
  return row as PullRequestPostLandingPayload
}
