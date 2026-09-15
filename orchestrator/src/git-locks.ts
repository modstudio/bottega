import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { targetGitEnvironment } from './git-environment.ts'
import { pidAlive } from './process-liveness.ts'

export type GitLock = {
  path: string
  since: string
  ageMs: number
  target: string | null
  contents: string
  contentRefs: string[]
  ownerPids: number[] | null
}

function git(cwd: string, args: string[]): string | null {
  const p = Bun.spawnSync(['git', ...args], {
    cwd,
    env: targetGitEnvironment(cwd),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return p.exitCode === 0 ? p.stdout.toString().trim() : null
}

function lockFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile() && entry.name.endsWith('.lock')) found.push(child)
    }
  }
  visit(root)
  return found
}

function owningPids(path: string): number[] | null {
  let p: ReturnType<typeof Bun.spawnSync>
  try {
    p = Bun.spawnSync(['lsof', '-t', '--', path], { stdout: 'pipe', stderr: 'pipe' })
  } catch {
    return null
  }
  // lsof uses 1 for a successful inventory with no matching open file.
  if (p.exitCode === 1 && !p.stderr?.toString().trim()) return []
  if (p.exitCode !== 0) return null
  return [
    ...new Set(
      (p.stdout?.toString() ?? '')
        .split('\n')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0 && pidAlive(value)),
    ),
  ]
}

const BINARY_CONTROL_PATTERN = String.raw`[\0-\x08\x0b\x0c\x0e-\x1f]`
const BINARY_CONTROL_CHARACTER = new RegExp(BINARY_CONTROL_PATTERN)

function lockContents(path: string): string {
  const bytes = readFileSync(path)
  if (bytes.length > 4096) return `[${bytes.length} bytes; content omitted]`
  const text = bytes.toString('utf8')
  if (BINARY_CONTROL_CHARACTER.test(text)) return `[${bytes.length} binary bytes]`
  return text.trim()
}

function targetFor(path: string, commonDir: string): string | null {
  const rel = relative(commonDir, path).split(sep).join('/')
  if (rel.startsWith('refs/') && rel.endsWith('.lock')) return rel.slice(0, -5)
  if (rel === 'packed-refs.lock') return 'packed-refs'
  if (path.endsWith(`${sep}index.lock`)) return 'index'
  return null
}

function refsForContents(repoRoot: string, contents: string): string[] {
  if (!/^[0-9a-f]{40,64}$/i.test(contents)) return []
  const refs = git(repoRoot, ['for-each-ref', '--format=%(refname)', `--points-at=${contents}`])
  return refs ? refs.split('\n').filter(Boolean) : []
}

/** Inventory lock files Git may leave behind. Observation never removes or rewrites one. */
export function gitLocks(repoRoot: string, clock = Date.now()): GitLock[] {
  const commonValue = git(repoRoot, ['rev-parse', '--git-common-dir'])
  if (!commonValue) throw new Error(`${repoRoot} is not a readable git repository`)
  const commonDir = resolve(repoRoot, commonValue)
  const paths = new Set<string>([
    ...lockFiles(join(commonDir, 'refs')),
    join(commonDir, 'packed-refs.lock'),
  ])
  const worktrees = git(repoRoot, ['worktree', 'list', '--porcelain']) ?? ''
  for (const line of worktrees.split('\n')) {
    if (!line.startsWith('worktree ')) continue
    const worktree = line.slice('worktree '.length)
    const gitDirValue = git(worktree, ['rev-parse', '--git-dir'])
    if (gitDirValue) paths.add(join(resolve(worktree, gitDirValue), 'index.lock'))
  }

  const locks: GitLock[] = []
  for (const path of [...paths].sort()) {
    try {
      if (!existsSync(path)) continue
      const stat = lstatSync(path)
      if (!stat.isFile()) continue
      const contents = lockContents(path)
      locks.push({
        path,
        since: new Date(stat.mtimeMs).toISOString(),
        ageMs: Math.max(0, clock - stat.mtimeMs),
        target: targetFor(path, commonDir),
        contents,
        contentRefs: refsForContents(repoRoot, contents),
        ownerPids: owningPids(path),
      })
    } catch (cause) {
      // A live Git operation may remove its lock between inventory and read.
      // The next status or monitor pass will observe whatever remains.
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }
  return locks
}

export function formatGitLocks(repoRoot: string, clock = Date.now()): string {
  const locks = gitLocks(repoRoot, clock)
  if (!locks.length) return 'git locks:\n  none'
  return `git locks:\n${locks
    .map((lock) => {
      const age = `${Math.max(0, Math.round(lock.ageMs / 1000))}s`
      const target = lock.target ? `\n    target: ${lock.target}` : ''
      const resolved = lock.contentRefs.length ? ` -> ${lock.contentRefs.join(', ')}` : ''
      const contents = lock.contents ? `${lock.contents}${resolved}` : '(empty)'
      const owner =
        lock.ownerPids === null
          ? 'unknown (lsof unavailable)'
          : lock.ownerPids.length
            ? `${lock.ownerPids.join(', ')} alive`
            : 'none alive'
      return `  ${lock.path} (age ${age})${target}\n    contents: ${contents}\n    owner pid: ${owner}`
    })
    .join('\n')}`
}
