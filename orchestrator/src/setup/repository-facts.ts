// concern: setup-repository-facts
/** Detects repository facts. Must not know the project register, setup policy, or CLI grammar. */
import { readdirSync, realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { inspectionGitEnv } from '../../../shared/git.ts'
import { sniffStack } from '../project/projects.ts'
import { detectRepositoryToolchain } from './repository-toolchain.ts'
import type { ToolchainFacts } from './setup-toolchain.ts'

export type RepositoryFacts = ToolchainFacts & {
  name: string
  path: string
  currentBranch: string | null
  clean: boolean
  originUrl: string | null
  originHost: string | null
  remoteDefaultBranch: string | null
  stack: string | null
  inspectionTimedOut: boolean
}

type RepositoryGitCapture = { exitCode: number; stdout: string; timedOut: boolean }
export type RepositoryGitRunner = (path: string, args: string[]) => RepositoryGitCapture
type RepositoryFactsNotice = { message: string; fix: string | null }
export type RepositoryFactsReport = {
  repositories: RepositoryFacts[]
  notices: RepositoryFactsNotice[]
}

const GIT_TIMEOUT_MS = 3_000

function git(path: string, args: string[]): RepositoryGitCapture {
  const child = Bun.spawnSync(['git', '-C', path, ...args], {
    env: inspectionGitEnv(),
    stdout: 'pipe',
    stderr: 'ignore',
    timeout: GIT_TIMEOUT_MS,
  })
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString().trim(),
    timedOut: child.exitedDueToTimeout === true,
  }
}

function repositoryRoot(
  path: string,
  runGit: RepositoryGitRunner,
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
  runGit: RepositoryGitRunner,
  sniff: (path: string) => string | null,
): Promise<RepositoryFacts> {
  const branch = runGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const status = runGit(path, ['status', '--porcelain'])
  const origin = runGit(path, ['remote', 'get-url', 'origin'])
  const remoteHead = runGit(path, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ])
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
    remoteDefaultBranch:
      !remoteHead.timedOut && remoteHead.exitCode === 0 && remoteHead.stdout
        ? remoteHead.stdout.replace(/^origin\//, '')
        : null,
    stack: sniff(path),
    inspectionTimedOut: [branch, status, origin, remoteHead].some((capture) => capture.timedOut),
    ...(await detectRepositoryToolchain(path)),
  }
}

/** Find a repository at each input and among only its immediate child directories. */
export async function gatherRepositoryFactsReport(
  folders: string[],
  runGit: RepositoryGitRunner = git,
  sniff: (path: string) => string | null = sniffStack,
): Promise<RepositoryFactsReport> {
  const repositories = new Map<string, RepositoryFacts>()
  const notices: RepositoryFactsNotice[] = []
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
