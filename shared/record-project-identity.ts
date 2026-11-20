// concern: record-project-identity
/** Resolves the hosted project identity while leaving route-specific retirement policy to callers. */
import { PLATFORM_SLUG } from './brand.ts'

export const MISSING_PROJECT_ID_REMEDY = `run \`${PLATFORM_SLUG} machine migrate\` to fill local project UUIDs`

export function projectOutsideRequestSpacePrefix(projectId: string): string {
  return `record project ${projectId} is absent from request space `
}

export function projectOutsideRequestSpaceMessage(input: {
  projectId: string
  requestSpaceId: string
  projectName?: string | null
}): string {
  return `${projectOutsideRequestSpacePrefix(input.projectId)}${input.requestSpaceId}${input.projectName ? ` (project ${JSON.stringify(input.projectName)})` : ''}`
}

export function projectOutsideRequestSpaceRemedy(input: {
  requestSpaceId: string
  projectName?: string | null
}): string {
  const project = input.projectName ? `project ${JSON.stringify(input.projectName)}` : 'the project'
  return `request was sent to record space ${input.requestSpaceId}; find ${project}'s declared space slug in settings.space from \`${PLATFORM_SLUG} project list --json\`, then retry against that space`
}

export type RecordProjectFacts = {
  id: string
  name: string
  spaceId: string
  retired: boolean
}

export type RecordProjectIdentityResult =
  | { status: 'found'; project: RecordProjectFacts; warnings: [] | ['name-mismatch'] }
  | { status: 'missing' | 'outside-space'; warnings: [] }

export function recordProjectIdentityDecision(input: {
  requestedId: string
  requestedName?: string | null
  requestedSpaceId?: string | null
  projects: RecordProjectFacts[]
}): RecordProjectIdentityResult {
  if (input.projects.length === 0) return { status: 'missing', warnings: [] }
  const project = input.projects[0]!
  if (input.requestedSpaceId && project.spaceId !== input.requestedSpaceId)
    return { status: 'outside-space', warnings: [] }
  return {
    status: 'found',
    project,
    warnings:
      input.requestedName != null && input.requestedName !== project.name ? ['name-mismatch'] : [],
  }
}
