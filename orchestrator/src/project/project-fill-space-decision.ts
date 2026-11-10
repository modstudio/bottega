// concern: project-fill-space-decision
/** Classifies one project's declared and hosted record spaces without I/O. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { declaredProjectSpaceRemedy } from '../../../shared/record-remedies.ts'
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

export function hostedProjectSpaceSlugs(
  memberships: readonly RecordSpaceMembership[],
  hostedSpaceIds: readonly string[],
): string[] {
  return [...new Set(hostedSpaceIds)]
    .map((spaceId) => memberships.find((membership) => membership.spaceId === spaceId))
    .filter((membership): membership is RecordSpaceMembership => membership !== undefined)
    .sort((left, right) => left.slug.localeCompare(right.slug))
    .map(({ slug }) => slug)
}

export function spaceFillNeedsRuling(decision: FillSpaceDecision): boolean {
  return (
    decision.kind === 'several-spaces' ||
    decision.kind === 'no-hosted-row' ||
    decision.kind === 'mismatch'
  )
}

export function projectSpaceFillRemedy(
  project: string,
  declaredSpace: string | null,
  decision: FillSpaceDecision,
): string {
  return declaredSpace && decision.kind === 'no-hosted-row'
    ? `${PLATFORM_SLUG} project push`
    : declaredProjectSpaceRemedy(project)
}

export function decideProjectSpaceFill(input: {
  declared?: string
  memberships: readonly RecordSpaceMembership[]
  hostedSpaceIds: readonly string[]
}): FillSpaceDecision {
  const spaces = hostedProjectSpaceSlugs(input.memberships, input.hostedSpaceIds)
  if (spaces.length > 1) return { kind: 'several-spaces', spaces }

  const declared = input.declared?.trim()
  const declaredMembership = declared
    ? recordSpaceMembership(declared, input.memberships)
    : undefined
  if (declared && !declaredMembership) return { kind: 'mismatch', declared, spaces }
  if (spaces.length === 0) return { kind: 'no-hosted-row' }
  if (!declaredMembership) return { kind: 'fill', space: spaces[0]! }
  const hostedMembership = recordSpaceMembership(spaces[0]!, input.memberships)
  return declaredMembership.spaceId === hostedMembership?.spaceId
    ? { kind: 'ok' }
    : { kind: 'mismatch', declared: declared!, spaces }
}
