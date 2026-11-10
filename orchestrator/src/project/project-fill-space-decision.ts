// concern: project-fill-space-decision
/** Classifies one project's declared and hosted record spaces without I/O. */

import {
  type RecordSpaceMembership,
  recordSpaceMembership,
} from '../../../shared/record-space-membership.ts'

export type FillSpaceDecision =
  | { kind: 'ok' }
  | { kind: 'fill'; space: string }
  | { kind: 'several-spaces'; spaces: string[] }
  | { kind: 'no-hosted-row' }
  | { kind: 'mismatch'; declared: string; spaces: string[] }

export function decideProjectSpaceFill(input: {
  declared?: string
  memberships: readonly RecordSpaceMembership[]
  hostedSpaceIds: readonly string[]
}): FillSpaceDecision {
  const hosted = [...new Set(input.hostedSpaceIds)]
    .map((spaceId) => input.memberships.find((membership) => membership.spaceId === spaceId))
    .filter((membership): membership is RecordSpaceMembership => membership !== undefined)
    .sort((left, right) => left.slug.localeCompare(right.slug))
  const spaces = hosted.map(({ slug }) => slug)
  if (hosted.length > 1) return { kind: 'several-spaces', spaces }

  const declared = input.declared?.trim()
  const declaredMembership = declared
    ? recordSpaceMembership(declared, input.memberships)
    : undefined
  if (declared && !declaredMembership) return { kind: 'mismatch', declared, spaces }
  if (hosted.length === 0) return { kind: 'no-hosted-row' }
  if (!declaredMembership) return { kind: 'fill', space: hosted[0]!.slug }
  return declaredMembership.spaceId === hosted[0]!.spaceId
    ? { kind: 'ok' }
    : { kind: 'mismatch', declared: declared!, spaces }
}
