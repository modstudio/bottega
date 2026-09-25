/** Decide whether a project write is hosted, local, or refused. Must not know stores or HTTP. */

export type HostedWriteMode = 'hosted-configured' | 'local-authoritative' | 'hosted-unavailable'

export type InstallBinding = {
  bound: boolean
  activeSpaceId: string | null
}

export const NEVER_BOUND: InstallBinding = { bound: false, activeSpaceId: null }

export type RegisteredProjectWrite = {
  name: string
  settings: {
    tracker?: { protocol?: string } | null
    space?: unknown
  }
}

export type ProjectWriteDecision =
  | { mode: 'hosted-configured' }
  | { mode: 'local-authoritative' }
  | {
      mode: 'refused'
      cause: 'remote-tracker' | 'hosted-space' | 'remote-tracker-and-hosted-space'
      reason: string
    }

export type ProjectWriteFacts = {
  hostedUrl: string | null | undefined
  remoteTracker: boolean
  belongsToHostedSpace: boolean
  project: string
}

export const MISSING_HOSTED_URL_REMEDY = 'Set HUB_HOSTED_URL and run `orch record doctor`.'
export const HOSTED_UNREACHABLE_REMEDY = 'Retry when the hosted record is reachable.'

export function hostedUnavailableRemedy(hostedUrl: string | null | undefined): string {
  return hostedUrl?.trim() ? HOSTED_UNREACHABLE_REMEDY : MISSING_HOSTED_URL_REMEDY
}

/** Hosted-configured when HUB_HOSTED_URL is set; otherwise local-authoritative. */
export function hostedWriteMode(hostedUrl: string | null | undefined): HostedWriteMode {
  if (hostedUrl?.trim()) return 'hosted-configured'
  return 'local-authoritative'
}

export function reportedWriteMode(
  hostedUrl: string | null | undefined,
  binding: InstallBinding,
): HostedWriteMode {
  if (hostedUrl?.trim()) return 'hosted-configured'
  return binding.bound ? 'hosted-unavailable' : 'local-authoritative'
}

/** A remote tracker is any configured tracker that is not the built-in hub protocol. */
export function projectHasRemoteTracker(
  tracker: { protocol?: string } | null | undefined,
): boolean {
  return Boolean(tracker) && tracker?.protocol !== 'hub'
}

export function projectMappedToHostedSpace(space: unknown): boolean {
  return typeof space === 'string' && Boolean(space.trim())
}

/**
 * One membership fact: a declared space, or any project on a hosted-bound install,
 * belongs to hosted space. A never-bound install with no declared space does not.
 */
export function projectBelongsToHostedSpace(
  declaredSpace: unknown,
  binding: InstallBinding,
): boolean {
  return projectMappedToHostedSpace(declaredSpace) || binding.bound
}

export function declaredProjectSpace(space: unknown): string | null {
  return projectMappedToHostedSpace(space) ? (space as string).trim() : null
}

function refusalCause(
  remoteTracker: boolean,
  belongsToHostedSpace: boolean,
): Extract<ProjectWriteDecision, { mode: 'refused' }>['cause'] {
  if (remoteTracker && belongsToHostedSpace) return 'remote-tracker-and-hosted-space'
  return remoteTracker ? 'remote-tracker' : 'hosted-space'
}

function refusalReason(
  project: string,
  remoteTracker: boolean,
  belongsToHostedSpace: boolean,
  hostedUrl: string | null | undefined,
): string {
  const parts = [
    remoteTracker ? 'declares a remote tracker' : null,
    belongsToHostedSpace ? 'belongs to a hosted space' : null,
  ].filter((part): part is string => part !== null)
  return `project '${project}' ${parts.join(' and ')}; local writes are refused while hosting is unavailable. ${hostedUnavailableRemedy(hostedUrl)}`
}

/** Per-project write authority from the hosted URL, install binding, and the project register. */
export function projectWriteDecision(facts: ProjectWriteFacts): ProjectWriteDecision {
  if (hostedWriteMode(facts.hostedUrl) === 'hosted-configured') return { mode: 'hosted-configured' }
  if (facts.remoteTracker || facts.belongsToHostedSpace) {
    return {
      mode: 'refused',
      cause: refusalCause(facts.remoteTracker, facts.belongsToHostedSpace),
      reason: refusalReason(
        facts.project,
        facts.remoteTracker,
        facts.belongsToHostedSpace,
        facts.hostedUrl,
      ),
    }
  }
  return { mode: 'local-authoritative' }
}

export function projectWriteDecisionFor(
  registeredProject: RegisteredProjectWrite,
  installBinding: InstallBinding,
  hostedUrl: string | null | undefined,
): ProjectWriteDecision {
  return projectWriteDecision({
    hostedUrl,
    remoteTracker: projectHasRemoteTracker(registeredProject.settings.tracker),
    belongsToHostedSpace: projectBelongsToHostedSpace(
      registeredProject.settings.space,
      installBinding,
    ),
    project: registeredProject.name,
  })
}

export function formatProjectWriteModes(
  projects: readonly RegisteredProjectWrite[],
  installBinding: InstallBinding,
  hostedUrl: string | null | undefined,
): string[] {
  return [
    `install        ${installBinding.bound ? 'hosted-bound' : 'never-bound'}`,
    `write mode     ${reportedWriteMode(hostedUrl, installBinding)}`,
    ...projects.map((project) => {
      const decision = projectWriteDecisionFor(project, installBinding, hostedUrl)
      const detail = decision.mode === 'refused' ? `refused (${decision.cause})` : decision.mode
      return `  ${project.name.padEnd(14)} ${detail}`
    }),
  ]
}
