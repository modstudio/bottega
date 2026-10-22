// concern: project-visibility
/** Verifies a stored repository-visibility declaration against its forge. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
export { githubRepository } from '../../../shared/github-repository.ts'

export type RepositoryVisibility = 'public' | 'private'

export type ForgeVisibilityLookup = (repository: string) => {
  exitCode: number
  stdout: string
  stderr: string
}

type GhSpawn = (argv: string[]) => {
  exitCode: number
  stdout: { toString(): string }
  stderr: { toString(): string }
}

/** Forge lookup whose failure result retains the project-set remedy path. */
export function githubForgeVisibilityLookup(
  repository: string,
  spawn: GhSpawn = (argv) => Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' }),
): ReturnType<ForgeVisibilityLookup> {
  try {
    const result = spawn(['gh', 'repo', 'view', repository, '--json', 'visibility'])
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }
  } catch (error) {
    return { exitCode: 127, stdout: '', stderr: String(error) }
  }
}

/** Canonical owner/name for HTTPS, SSH URL, and SCP-like GitHub repository addresses. */
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
