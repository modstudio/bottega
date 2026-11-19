// concern: setup-repository-facts
/** Detects repository facts. Must not know the project register, setup policy, or CLI grammar. */
import { readdirSync, realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { type GitProbeRunner, runGitProbe } from '../../../shared/git.ts'
import { readOriginHeadBranch, sniffStack } from '../project/projects.ts'
import type { RepositoryFacts } from './repository-facts-types.ts'
import { detectRepositoryToolchain } from './repository-toolchain.ts'
import type { SetupNotice } from './setup-engine.ts'

export type { RepositoryFacts } from './repository-facts-types.ts'

export type RepositoryFactsReport = {
  repositories: RepositoryFacts[]
  notices: SetupNotice[]
}

function repositoryRoot(
  path: string,
  runGit: GitProbeRunner,
): { root: string | null; timedOut: boolean } {
  const result = runGit(path, ['rev-parse', '--show-toplevel'])
  if (result.timedOut) return { root: null, timedOut: true }
  if (result.exitCode !== 0 || !result.stdout) return { root: null, timedOut: result.timedOut }
  try {
    return { root: realpathSync(result.stdout), timedOut: result.timedOut }
  } catch {
    return { root: null, timedOut: result.timedOut }
  }
}

function redactOriginUrl(url: string | null): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return url.replace(/^[^@/:]+@([^:]+:)/, '$1')
  }
}

function originHost(url: string | null): string | null {
  if (!url) return null
  try {
    const hostname = new URL(url).hostname
    if (hostname) return hostname
  } catch {
    // Fall through to scp-style parsing.
  }
  return url.match(/^([^:]+):/)?.[1] ?? null
}

async function inspectRepository(
  path: string,
  runGit: GitProbeRunner,
  sniff: (path: string) => string | null,
): Promise<RepositoryFacts> {
  const branch = runGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const status = runGit(path, ['status', '--porcelain'])
  const origin = runGit(path, ['remote', 'get-url', 'origin'])
  const remoteHead = readOriginHeadBranch(path, runGit)
  const originUrl = redactOriginUrl(
    !origin.timedOut && origin.exitCode === 0 && origin.stdout ? origin.stdout : null,
  )
  return {
    name: basename(path),
    path,
    currentBranch:
      !branch.timedOut && branch.exitCode === 0 && branch.stdout ? branch.stdout : null,
    clean: !status.timedOut && status.exitCode === 0 && status.stdout === '',
    originUrl,
    originHost: originHost(originUrl),
    remoteDefaultBranch: !remoteHead.timedOut ? remoteHead.branch : null,
    stack: sniff(path),
    inspectionTimedOut: [branch, status, origin, remoteHead].some((capture) => capture.timedOut),
    ...(await detectRepositoryToolchain(path)),
  }
}

/** Find a repository at each input and among only its immediate child directories. */
export async function gatherRepositoryFactsReport(
  folders: string[],
  runGit: GitProbeRunner = runGitProbe,
  sniff: (path: string) => string | null = sniffStack,
): Promise<RepositoryFactsReport> {
  const repositories = new Map<string, RepositoryFacts>()
  const notices: SetupNotice[] = []
  for (const folder of folders) {
    const root = resolve(folder)
    const candidates = [root]
    try {
      candidates.push(
        ...readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => resolve(root, entry.name)),
      )
    } catch {
      // A missing or unreadable input simply contains no discoverable repository.
    }
    for (const candidate of candidates) {
      const inspected = repositoryRoot(candidate, runGit)
      if (inspected.timedOut) {
        notices.push({
          message: `git inspection timed out for ${basename(candidate)} at ${candidate}`,
          fix: `git -C ${candidate} rev-parse --show-toplevel`,
          blocking: true,
          folderPath: candidate,
        })
      }
      const top = inspected.root
      if (!top || top !== realpathOrNull(candidate) || repositories.has(top)) continue
      repositories.set(top, await inspectRepository(top, runGit, sniff))
    }
  }
  return { repositories: [...repositories.values()], notices }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}
