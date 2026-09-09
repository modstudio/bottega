import { existsSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'

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
      stdout: 'pipe', stderr: 'pipe', env: localEnvVarQueryEnv(),
    })
    if (result.exitCode !== 0) return []
    const names = result.stdout.toString().split(/\s+/).filter(Boolean)
    if (names.length) listedLocalEnvVars = names
    return names
  } catch {
    return []
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
 * is global-behaviour, like GIT_EDITOR). Inspection still must not pick up a
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
    const result = Bun.spawnSync(['git', '-C', path, '--no-optional-locks', ...args], {
      env: inspectionGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    return { code: result.exitCode ?? 128, stdout: result.stdout?.toString() ?? '' }
  } catch {
    return { code: 128, stdout: '' }
  }
}

/** Resolve the main checkout belonging to a checkout or linked worktree. */
export function mainCheckoutOf(cwd: string, env?: Record<string, string | undefined>): string | null {
  if (!existsSync(cwd)) return null
  const result = Bun.spawnSync(
    ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, env: env ?? inspectionGitEnv(),
      stdout: 'pipe', stderr: 'ignore' },
  )
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

export type CheckoutCleanliness = 'clean' | 'dirty' | 'indeterminate'

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
    if (xy === '??') {
      if (path) untracked.push(path)
      continue
    }
    if (path) dirtyTracked.push(path)
  }
  return { dirtyTracked: uniquePaths(dirtyTracked), untracked }
}

function gitPathExists(cwd: string, name: string): boolean | null {
  const result = gitAt(cwd, ['rev-parse', '--path-format=absolute', '--git-path', name])
  if (result.code !== 0 || !result.stdout.trim()) return null
  return existsSync(result.stdout.trim())
}

function refExists(cwd: string, name: string): boolean | null {
  const result = gitAt(cwd, ['rev-parse', '--verify', '--quiet', name])
  if (result.code === 0) return true
  if (result.code === 1) return false
  return null
}

/**
 * Sequencer directories have no porcelain. rebase-merge / rebase-apply /
 * BISECT_LOG are in-progress even on a clean tree. .git/sequencer is the
 * multi cherry-pick/revert stop: without it, CHERRY_PICK_HEAD over a clean
 * tree cannot be told from DEV-432 residue (a completed pick whose
 * pseudo-ref lingered). Pseudo-refs without a directory over a clean tree
 * are residue; the same refs over a dirty tree are in progress.
 */
function inspectSequence(cwd: string, dirty: boolean): SequenceState {
  const rebaseMerge = gitPathExists(cwd, 'rebase-merge')
  const rebaseApply = gitPathExists(cwd, 'rebase-apply')
  const bisectLog = gitPathExists(cwd, 'BISECT_LOG')
  const sequencer = gitPathExists(cwd, 'sequencer')
  if (rebaseMerge === null || rebaseApply === null || bisectLog === null || sequencer === null) {
    return INDETERMINATE
  }
  const merge = refExists(cwd, 'MERGE_HEAD')
  const cherryPick = refExists(cwd, 'CHERRY_PICK_HEAD')
  const rebase = refExists(cwd, 'REBASE_HEAD')
  const revert = refExists(cwd, 'REVERT_HEAD')
  if (merge === null || cherryPick === null || rebase === null || revert === null) {
    return INDETERMINATE
  }
  if (bisectLog) return { status: 'in-progress', kind: 'bisect' }
  if (rebaseMerge) return { status: 'in-progress', kind: 'rebase' }
  if (rebaseApply) return { status: 'in-progress', kind: rebase ? 'rebase' : 'am' }
  if (sequencer) {
    return { status: 'in-progress', kind: revert ? 'revert' : 'cherry-pick' }
  }
  if (merge) return dirty ? { status: 'in-progress', kind: 'merge' } : { status: 'residue', kind: 'merge' }
  if (cherryPick) {
    return dirty ? { status: 'in-progress', kind: 'cherry-pick' } : { status: 'residue', kind: 'cherry-pick' }
  }
  if (rebase) return dirty ? { status: 'in-progress', kind: 'rebase' } : { status: 'residue', kind: 'rebase' }
  if (revert) return dirty ? { status: 'in-progress', kind: 'revert' } : { status: 'residue', kind: 'revert' }
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
    cleanliness: 'indeterminate', dirtyTracked: [], untracked: [], sequence,
  })
  const status = gitAt(path, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=untracked', '--',
  ])
  if (status.code !== 0) return indeterminate()
  const { dirtyTracked, untracked } = parsePorcelain(status.stdout)
  const dirty = dirtyTracked.length > 0
  const sequence = inspectSequence(path, dirty)
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
