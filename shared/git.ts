import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * Hermetic git against a chosen tree.
 *
 * No library packages "read-only, is-this-tree-clean including sequencer
 * state" as one concern. git-is-clean and is-git-clean check dirtiness only —
 * no env scrubbing, no sequence detection. isomorphic-git sidesteps the
 * environment by reimplementing git, which is a whole git and not a utility.
 * Buy the primitives, compose them here, take no dependency.
 *
 * Invocation is git's own recipe (githooks(5)):
 *   unset $(git rev-parse --local-env-vars)
 * That prints the names; it is version-correct by construction. Duplicating
 * this CALL in another language is not a defect; duplicating a LIST of
 * variable names is. Git supplies the names at run time.
 *
 * protect-main-checkout.py and dispatch ask different questions and share
 * this invocation, not a cleanliness verdict.
 */

const ORCH_ROUTING = ['ORCH_GUARDED_GIT_COMMON_DIR', 'ORCH_ALLOWED_GIT_REF'] as const

let listedLocalEnvVars: string[] | undefined

function localEnvVarQueryEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin' }
}

function localEnvVarNames(): string[] {
  if (listedLocalEnvVars) return listedLocalEnvVars
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', '--local-env-vars'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: localEnvVarQueryEnv(),
    })
    if (result.exitCode !== 0) {
      throw new Error(
        `refusing operational git: git rev-parse --local-env-vars failed with exit ${result.exitCode ?? 'unknown'}: ${result.stderr.toString().trim() || 'no error output'}`,
      )
    }
    const names = result.stdout.toString().split(/\s+/).filter(Boolean)
    // GIT_DIR is the minimum useful answer, not a fallback list. Without it,
    // the query cannot establish that repository routing will be removed.
    if (!names.includes('GIT_DIR')) {
      throw new Error(
        'refusing operational git: git rev-parse --local-env-vars did not list GIT_DIR',
      )
    }
    listedLocalEnvVars = names
    return names
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('refusing operational git:')) throw error
    throw new Error(
      `refusing operational git: could not run git rev-parse --local-env-vars: ${String(error)}`,
    )
  }
}

/** Drop repository-location variables git lists, plus orch ref-guard routing. */
export function scrubbedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const name of localEnvVarNames()) delete env[name]
  for (const name of ORCH_ROUTING) delete env[name]
  return env
}

/**
 * Git env for a read of a foreign checkout.
 *
 * `git rev-parse --local-env-vars` excludes GIT_CONFIG_GLOBAL on purpose (it
 * is global-behavior, like GIT_EDITOR). Inspection still must not pick up a
 * worker's global config file, so isolation is stated here rather than as a
 * side effect of the shared scrub.
 */
export function inspectionGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = scrubbedGitEnv(base)
  env.GIT_CONFIG_GLOBAL = '/dev/null'
  return env
}

type GitResult = { code: number; stdout: string }

function gitAt(path: string, args: string[]): GitResult {
  if (!existsSync(path)) return { code: 128, stdout: '' }
  try {
    const env = inspectionGitEnv()
    delete env.LANGUAGE
    env.LC_ALL = 'C'
    env.LANG = 'C'
    const result = Bun.spawnSync(['git', '-C', path, '--no-optional-locks', ...args], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { code: result.exitCode ?? 128, stdout: result.stdout?.toString() ?? '' }
  } catch {
    return { code: 128, stdout: '' }
  }
}

/**
 * Resolve the one source checkout named by a shared clone's alternates file.
 *
 * Git resolves relative alternates against the borrowing repository's objects
 * directory. Comments and blank lines carry no object source. The accepted
 * shape deliberately names a non-bare checkout's `.git/objects`, never an
 * arbitrary object database.
 */
export function borrowedCheckoutFromAlternates(
  contents: string | null,
  objectsDirectory: string,
): string | null {
  if (contents === null) return null
  const lines = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  if (lines.length !== 1) return null
  const objects = resolve(objectsDirectory, lines[0]!)
  if (basename(objects) !== 'objects' || basename(dirname(objects)) !== '.git') return null
  return dirname(dirname(objects))
}

/** Read and validate the shared-clone identity exposed by a checkout. */
export function borrowedCheckoutOf(cwd: string): string | null {
  const gitDir = gitAt(cwd, ['rev-parse', '--path-format=absolute', '--git-dir'])
  if (gitDir.code !== 0 || !gitDir.stdout.trim()) return null
  const objectsDirectory = join(gitDir.stdout.trim(), 'objects')
  let contents: string
  try {
    contents = readFileSync(join(objectsDirectory, 'info', 'alternates'), 'utf8')
  } catch {
    return null
  }
  const source = borrowedCheckoutFromAlternates(contents, objectsDirectory)
  if (!source) return null
  try {
    if (!statSync(join(source, '.git')).isDirectory()) return null
    const bare = gitAt(source, ['rev-parse', '--is-bare-repository'])
    const top = gitAt(source, ['rev-parse', '--path-format=absolute', '--show-toplevel'])
    if (bare.code !== 0 || bare.stdout.trim() !== 'false' || top.code !== 0) return null
    return realpathSync(top.stdout.trim()) === realpathSync(source) ? realpathSync(source) : null
  } catch {
    return null
  }
}

/** Resolve the main checkout belonging to a checkout or linked worktree. */
export function mainCheckoutOf(
  cwd: string,
  env?: Record<string, string | undefined>,
): string | null {
  if (!existsSync(cwd)) return null
  const borrowed = borrowedCheckoutOf(cwd)
  if (borrowed) return borrowed
  const result = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    env: env ?? inspectionGitEnv(),
    stdout: 'pipe',
    stderr: 'ignore',
  })
  if (result.exitCode !== 0) return null
  const common = result.stdout.toString().trim()
  return common ? dirname(common) : null
}

/** Absolute toplevel, or null when git cannot answer. */
export function gitToplevel(cwd: string): string | null {
  const result = gitAt(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel'])
  if (result.code !== 0 || !result.stdout.trim()) return null
  return result.stdout.trim()
}

export type SequenceKind = 'merge' | 'cherry-pick' | 'rebase' | 'revert' | 'am' | 'bisect'

export type SequenceState =
  | { status: 'none' }
  | { status: 'indeterminate' }
  | { status: 'in-progress'; kind: SequenceKind }
  | { status: 'residue'; kind: SequenceKind }

type CheckoutCleanliness = 'clean' | 'dirty' | 'indeterminate'

export type CheckoutState = {
  cleanliness: CheckoutCleanliness
  dirtyTracked: string[]
  untracked: string[]
  sequence: SequenceState
}

const NONE: SequenceState = { status: 'none' }
const INDETERMINATE: SequenceState = { status: 'indeterminate' }

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)]
}

function parsePorcelain(stdout: string): { dirtyTracked: string[]; untracked: string[] } {
  const dirtyTracked: string[] = []
  const untracked: string[] = []
  const parts = stdout.split('\0').filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    const xy = entry.slice(0, 2)
    const path = entry.length >= 3 && entry[2] === ' ' ? entry.slice(3) : entry.replace(/^.. /, '')
    if (xy[0] === 'R' || xy[0] === 'C') {
      const orig = parts[i + 1]
      if (orig && !/^[ MADRCU?!]{2} /.test(orig)) i++
      if (path) dirtyTracked.push(path)
      continue
    }
    // Porcelain v1's complete leading-code policy:
    //   ?? is untracked and warns; !! is ignored and is neither (the status
    //   invocation does not request ignored entries); every index/worktree
    //   code M, T, A, D, R, C or U is tracked dirt and blocks. Spaces mean
    //   that side is unchanged, not that the other side can be ignored.
    if (xy === '??') {
      if (path) untracked.push(path)
      continue
    }
    if (xy === '!!') continue
    if (path) dirtyTracked.push(path)
  }
  return { dirtyTracked: uniquePaths(dirtyTracked), untracked }
}

/**
 * Ask git whether an operation is in progress. This intentionally reads
 * status's own operation diagnosis instead of reconstructing it from
 * pseudo-refs, directories, or working-tree dirt. LC_ALL makes the stable git
 * diagnostics below independent of the operator's locale.
 *
 * Git status cannot distinguish a leftover CHERRY_PICK_HEAD over a clean tree
 * from a live empty cherry-pick: both say "currently cherry-picking" and
 * "nothing to commit". Refusing both is deliberate; dispatching during the
 * live operation is worse than a false refusal on residue.
 */
function inspectSequence(cwd: string): SequenceState {
  const status = gitAt(cwd, ['-c', 'color.status=false', 'status', '--untracked-files=no'])
  if (status.code !== 0) return INDETERMINATE
  const text = status.stdout
  if (/still merging|you have unmerged paths/i.test(text))
    return { status: 'in-progress', kind: 'merge' }
  if (/rebase in progress|currently rebasing/i.test(text))
    return { status: 'in-progress', kind: 'rebase' }
  if (/am session/i.test(text)) return { status: 'in-progress', kind: 'am' }
  if (/currently bisecting/i.test(text)) return { status: 'in-progress', kind: 'bisect' }
  if (/currently reverting/i.test(text)) return { status: 'in-progress', kind: 'revert' }
  if (/currently cherry-picking/i.test(text)) return { status: 'in-progress', kind: 'cherry-pick' }
  return NONE
}

/**
 * Read-only checkout state: tracked dirt, untracked names, sequencer.
 *
 * Tracked dirt and the untracked list come from one invocation:
 * `git --no-optional-locks status --porcelain=v1`. --no-optional-locks is
 * the lock fix; status is the content check. `diff --quiet HEAD` writes the
 * index on a stale mtime; `diff-files --quiet` reports that mtime as dirty
 * without hashing. Status does neither. Indeterminate is a third state and
 * is never coerced to clean.
 */
export function inspectCheckout(path: string): CheckoutState {
  const indeterminate = (sequence: SequenceState = INDETERMINATE): CheckoutState => ({
    cleanliness: 'indeterminate',
    dirtyTracked: [],
    untracked: [],
    sequence,
  })
  const status = gitAt(path, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=untracked',
    '--',
  ])
  if (status.code !== 0) return indeterminate()
  const { dirtyTracked, untracked } = parsePorcelain(status.stdout)
  const dirty = dirtyTracked.length > 0
  const sequence = inspectSequence(path)
  return {
    cleanliness: dirty ? 'dirty' : 'clean',
    dirtyTracked,
    untracked,
    sequence,
  }
}

/** Compare resolved paths the way inspectMainCheckout already does. */
export function resolvedPathsEqual(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}
