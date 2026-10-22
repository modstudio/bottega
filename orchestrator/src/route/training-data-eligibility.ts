import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { RepositoryVisibility } from '../../../shared/repository-visibility.ts'

export function trainingDataEligibility(input: {
  agent: string
  trainsOnInputs: boolean
  project: string | null
  visibility: RepositoryVisibility | null
  verifiedRepository: string | null
  currentRepository: string | null
}): { eligible: boolean; why: string } {
  if (!input.trainsOnInputs) return { eligible: true, why: '' }
  if (
    input.project !== null &&
    input.visibility === 'public' &&
    input.verifiedRepository !== null &&
    input.currentRepository === input.verifiedRepository
  ) {
    return { eligible: true, why: '' }
  }
  const project = input.project ?? '(no project)'
  if (input.project !== null && input.visibility === 'public') {
    return {
      eligible: false,
      why:
        `project ${project} is declared public, but its current origin ` +
        `${input.currentRepository ?? '(unresolved)'} does not match verified repository ` +
        `${input.verifiedRepository ?? '(unrecorded)'}; agent ${input.agent} may train on inputs; ` +
        `cleared by: re-run ${PLATFORM_SLUG} project set ${input.project} --settings '{"visibility":"public"}', or choose another agent`,
    }
  }
  const declaration =
    input.project === null
      ? 'dispatch from a registered public project'
      : `declare it public with ${PLATFORM_SLUG} project set ${input.project} --settings '{"visibility":"public"}'`
  return {
    eligible: false,
    why:
      `project ${project} is not declared public and agent ${input.agent} may train on inputs; ` +
      `cleared by: ${declaration} (the declaration is verified against the forge), or choose another agent`,
  }
}
