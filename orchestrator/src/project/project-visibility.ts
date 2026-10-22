// concern: project-visibility
/** Verifies a stored repository-visibility declaration against its forge. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type RepositoryVisibility = 'public' | 'private'

export type ForgeVisibilityLookup = (repository: string) => {
  exitCode: number
  stdout: string
  stderr: string
}

/** Canonical owner/name for HTTPS, SSH URL, and SCP-like GitHub repository addresses. */
export function githubRepository(value: string): string | null {
  const match =
    /^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      value.trim(),
    )
  return match ? `${match[1]}/${match[2]}` : null
}

function forgeVisibility(value: string): RepositoryVisibility | null {
  try {
    const parsed = JSON.parse(value) as { visibility?: unknown }
    const visibility = typeof parsed.visibility === 'string' ? parsed.visibility.toLowerCase() : ''
    return visibility === 'public' || visibility === 'private' ? visibility : null
  } catch {
    return null
  }
}

export function assertForgeVisibility(input: {
  project: string
  repository: string
  declared: RepositoryVisibility
  lookup: ForgeVisibilityLookup
}): void {
  const result = input.lookup(input.repository)
  if (result.exitCode !== 0) {
    throw new Error(
      `${input.project}: could not verify repository visibility for ${input.repository}: ${result.stderr.trim() || `gh exited ${result.exitCode}`}\n` +
        `cleared by: restore gh access, then retry ${PLATFORM_SLUG} project set ${input.project} --settings '{"visibility":"${input.declared}"}'`,
    )
  }
  const actual = forgeVisibility(result.stdout)
  if (!actual) {
    throw new Error(
      `${input.project}: forge returned no public or private visibility for ${input.repository}\n` +
        `cleared by: verify with gh repo view ${input.repository} --json visibility, then retry the project update`,
    )
  }
  if (actual !== input.declared) {
    throw new Error(
      `${input.project}: declared repository visibility ${input.declared} does not match forge visibility ${actual} for ${input.repository}\n` +
        `cleared by: set visibility to ${actual}, or change the forge visibility before retrying`,
    )
  }
}
