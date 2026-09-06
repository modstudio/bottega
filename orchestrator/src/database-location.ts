import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

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
}

export const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')

const worktreeSegment = '/.claude/worktrees/'

function sourceBelongsToRepository(repositoryRoot: string, binaryRoot: string): boolean {
  const source = resolve(binaryRoot)
  const root = resolve(repositoryRoot)
  // This is the pre-database identity test from DEV-286: source is either the
  // main checkout's orchestrator/ or an orchestrator/ inside that root's
  // .claude/worktrees/. A sibling project's root matches neither shape.
  return source === join(root, 'orchestrator') ||
    (source.startsWith(`${join(root, '.claude', 'worktrees')}/`) && basename(source) === 'orchestrator')
}

type RepositoryRoot = { root: string; method: 'git-common-dir' | 'git-pointer' }

function repositoryRootFromGit(cwd: string): RepositoryRoot | null {
  try {
    const git = Bun.spawnSync(
      ['git', 'rev-parse', '--is-bare-repository', '--git-common-dir'], {
      cwd, stdout: 'pipe', stderr: 'ignore',
      },
    )
    if (git.exitCode !== 0) return null
    const [bare, commonOutput] = git.stdout.toString().trim().split('\n')
    if (!commonOutput || (bare !== 'true' && bare !== 'false')) return null
    const common = resolve(cwd, commonOutput)
    return { root: bare === 'true' ? common : dirname(common), method: 'git-common-dir' }
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
          return { root: current, method: 'git-pointer' }
        }
        const match = readFileSync(dotGit, 'utf8').trim().match(/^gitdir: (.+)$/)
        if (!match) throw new Error(`invalid git worktree pointer: ${dotGit}`)
        const gitDir = resolve(current, match[1]!)
        const worktrees = dirname(gitDir)
        const common = dirname(worktrees)
        if (basename(worktrees) !== 'worktrees' || basename(common) !== '.git' || dirname(gitDir) === gitDir) {
          throw new Error(`invalid git worktree pointer: ${dotGit}`)
        }
        return { root: dirname(common), method: 'git-pointer' }
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
    return {
      path: resolve(env.ORCH_DB), method: 'ORCH_DB', tried: [resolve(env.ORCH_DB)], registeredPath: null,
      repositoryRoot: null, repositoryCandidate: null, repositoryCandidateExisted: false,
      initializable: true,
    }
  }

  const binaryRelative = join(binaryRoot, 'orch.db')
  const tried: string[] = []
  const repository = repositoryRootFromGit(cwd) ?? repositoryRootFromDotGit(cwd)
  if (repository) {
    const candidate = join(repository.root, 'orchestrator', 'orch.db')
    tried.push(candidate)
    const candidateExists = existsSync(candidate)
    const ownsSource = sourceBelongsToRepository(repository.root, binaryRoot)
    if (candidateExists || ownsSource) {
      return {
        path: candidate, method: repository.method, tried, registeredPath: null,
        repositoryRoot: repository.root, repositoryCandidate: candidate,
        repositoryCandidateExisted: candidateExists,
        // A worktree-local binary may diagnose its main checkout, but only the
        // main checkout's binary may initialize that checkout.
        initializable: candidateExists || !resolve(binaryRoot).includes(worktreeSegment),
      }
    }
  }

  tried.push(binaryRelative)
  if (!resolve(binaryRoot).includes(worktreeSegment)) {
    return {
      path: binaryRelative, method: 'binary-relative', tried, registeredPath: null,
      repositoryRoot: repository?.root ?? null,
      repositoryCandidate: repository ? join(repository.root, 'orchestrator', 'orch.db') : null,
      repositoryCandidateExisted: false, initializable: true,
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
