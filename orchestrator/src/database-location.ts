import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { scrubbedGitEnv } from '../../shared/git.ts'

export type DatabaseResolutionMethod = 'ORCH_DB' | 'git-common-dir' | 'git-pointer' | 'binary-relative'

export type DatabaseResolution = {
  path: string
  method: DatabaseResolutionMethod
  tried: string[]
  registeredPath: string | null
  repositoryRoot: string | null
  repositoryCandidate: string | null
  repositoryCandidateExisted: boolean
  initializable: boolean
  linkedWorktreeBinary: boolean
}

export const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

type RepositoryRoot = {
  root: string
  method: 'git-common-dir' | 'git-pointer'
  linked: boolean
}

function repositoryRootFromGit(cwd: string): RepositoryRoot | null {
  try {
    const git = Bun.spawnSync(
      ['git', 'rev-parse', '--is-bare-repository', '--git-dir', '--git-common-dir'], {
      cwd, env: scrubbedGitEnv(), stdout: 'pipe', stderr: 'ignore',
      },
    )
    if (git.exitCode !== 0) return null
    const [bare, gitDirOutput, commonOutput] = git.stdout.toString().trim().split('\n')
    if (!gitDirOutput || !commonOutput || (bare !== 'true' && bare !== 'false')) return null
    const gitDir = resolve(cwd, gitDirOutput)
    const common = resolve(cwd, commonOutput)
    return {
      root: bare === 'true' ? common : dirname(common),
      method: 'git-common-dir',
      linked: gitDir !== common,
    }
  } catch {
    return null
  }
}

/**
 * Git may be unable to traverse a linked worktree's common directory even
 * though the worktree pointer and the database beside the main checkout remain
 * readable. The pointer has one safe shape: <main>/.git/worktrees/<name>.
 */
function repositoryRootFromDotGit(cwd: string): RepositoryRoot | null {
  let current = resolve(cwd)
  while (true) {
    const dotGit = join(current, '.git')
    if (existsSync(dotGit)) {
      try {
        if (statSync(dotGit).isDirectory()) {
          return { root: current, method: 'git-pointer', linked: false }
        }
        const match = readFileSync(dotGit, 'utf8').trim().match(/^gitdir: (.+)$/)
        if (!match) throw new Error(`invalid git worktree pointer: ${dotGit}`)
        const gitDir = resolve(current, match[1]!)
        const worktrees = dirname(gitDir)
        const common = dirname(worktrees)
        if (basename(worktrees) !== 'worktrees' || basename(common) !== '.git' || dirname(gitDir) === gitDir) {
          throw new Error(`invalid git worktree pointer: ${dotGit}`)
        }
        return { root: dirname(common), method: 'git-pointer', linked: true }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('invalid git worktree pointer:')) throw error
        throw new Error(`cannot read git repository marker: ${dotGit}: ${String(error)}`)
      }
    }
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function resolveDatabase(
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  binaryRoot = ROOT,
): DatabaseResolution {
  if (env.ORCH_DB) {
    const binaryRepository = repositoryRootFromGit(binaryRoot) ?? repositoryRootFromDotGit(binaryRoot)
    return {
      path: resolve(env.ORCH_DB), method: 'ORCH_DB', tried: [resolve(env.ORCH_DB)], registeredPath: null,
      repositoryRoot: null, repositoryCandidate: null, repositoryCandidateExisted: false,
      initializable: true,
      linkedWorktreeBinary: Boolean(binaryRepository?.linked),
    }
  }

  const binaryRelative = join(binaryRoot, 'orch.db')
  const tried: string[] = []
  const repository = repositoryRootFromGit(cwd) ?? repositoryRootFromDotGit(cwd)
  const binaryRepository = repositoryRootFromGit(binaryRoot) ?? repositoryRootFromDotGit(binaryRoot)
  if (repository) {
    const candidate = join(repository.root, 'orchestrator', 'orch.db')
    tried.push(candidate)
    const candidateExists = existsSync(candidate)
    // Before the database can confirm the register, Git establishes identity:
    // cwd and the binary source belong to the same common repository root.
    const ownsSource = binaryRepository && resolve(binaryRepository.root) === resolve(repository.root)
    if (candidateExists || ownsSource) {
      return {
        path: candidate, method: repository.method, tried, registeredPath: null,
        repositoryRoot: repository.root, repositoryCandidate: candidate,
        repositoryCandidateExisted: candidateExists,
        // A worktree-local binary may diagnose its main checkout, but only the
        // main checkout's binary may initialize that checkout.
        initializable: Boolean(binaryRepository && !binaryRepository.linked),
        linkedWorktreeBinary: Boolean(binaryRepository?.linked),
      }
    }
  }

  if (binaryRepository?.linked) {
    const mainCandidate = join(binaryRepository.root, 'orchestrator', 'orch.db')
    if (!tried.includes(mainCandidate)) tried.push(mainCandidate)
    if (existsSync(mainCandidate)) {
      return {
        path: mainCandidate, method: binaryRepository.method, tried, registeredPath: null,
        repositoryRoot: repository?.root ?? null,
        repositoryCandidate: repository ? join(repository.root, 'orchestrator', 'orch.db') : null,
        repositoryCandidateExisted: false, initializable: false,
        linkedWorktreeBinary: true,
      }
    }
  }

  tried.push(binaryRelative)
  if (binaryRepository && !binaryRepository.linked) {
    return {
      path: binaryRelative, method: 'binary-relative', tried, registeredPath: null,
      repositoryRoot: repository?.root ?? null,
      repositoryCandidate: repository ? join(repository.root, 'orchestrator', 'orch.db') : null,
      repositoryCandidateExisted: false, initializable: true,
      linkedWorktreeBinary: false,
    }
  }

  throw new Error(
    `orchestrator database could not be resolved; tried:\n${tried.map((path) => `  ${path}`).join('\n')}\n` +
    `run orch init-db from the main checkout to create it`,
  )
}

export const DATABASE_RESOLUTION = resolveDatabase()
export const DB_PATH = DATABASE_RESOLUTION.path

export function missingDatabaseMessage(path = DB_PATH): string {
  return `orchestrator database does not exist: ${path}\nrun orch init-db to create it`
}

export function registeredRepositoryMissingDatabase(
  resolution: DatabaseResolution,
  registeredRoot: string,
): string | null {
  if (
    resolution.repositoryRoot && resolution.repositoryCandidate &&
    !resolution.repositoryCandidateExisted && resolution.path !== resolution.repositoryCandidate &&
    resolve(registeredRoot) === resolve(resolution.repositoryRoot)
  ) return resolution.repositoryCandidate
  return null
}

export function resolveRunsDirectory(
  resolution: Pick<DatabaseResolution, 'path'> = DATABASE_RESOLUTION,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  return env.ORCH_RUNS ? resolve(env.ORCH_RUNS) : join(dirname(resolution.path), 'runs')
}
