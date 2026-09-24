// concern: ref-guard

import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pidAlive } from '../../../shared/process-identity.ts'
import { db, ROOT } from '../database/db.ts'
import { commonGitDir, gitConfigOk, linkedWorktreePaths } from '../git/git-environment.ts'
import { ORCH_RUN_MARKER } from '../worktree/worktree-attribution.ts'

export type SharedRefGuardEnvironment = {
  GIT_CONFIG_COUNT: string
  GIT_CONFIG_KEY_0: string
  GIT_CONFIG_VALUE_0: string
  ORCH_GUARDED_GIT_COMMON_DIR: string
  ORCH_ALLOWED_GIT_REF?: string
}

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

const REF_GUARD_WRAPPER_MARKER = '# orch shared-ref guard wrapper\n'
const READONLY_PRE_PUSH = '#!/bin/sh\necho "read-only runs never push" >&2\nexit 1\n'

function sharedRefGuardWrapper(hookDir: string, guard: string, original: string): string {
  const guardMarker = Buffer.from(guard).toString('base64')
  const originalMarker = Buffer.from(original).toString('base64')
  return `#!/bin/sh\n${REF_GUARD_WRAPPER_MARKER}# guard-hook-base64: ${guardMarker}\n# original-hook-base64: ${originalMarker}\nset -eu\nprotected_common=\${ORCH_GUARDED_GIT_COMMON_DIR:-}\n[ -n "$protected_common" ] || exit 0\ncurrent_common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0\ncurrent_common=$(cd "$current_common" 2>/dev/null && pwd -P) || exit 0\n[ "$current_common" = "$protected_common" ] || exit 0\ninput=${shellQuote(join(hookDir, '.reference-transaction-input'))}.$$\ntrap 'rm -f "$input"' EXIT HUP INT TERM\ncat > "$input"\n${shellQuote(guard)} "$@" < "$input"\n${shellQuote(original)} "$@" < "$input"\n`
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

type InstalledRefGuard = {
  kind: 'guard' | 'wrapper'
  content: Buffer
  executable: boolean
  wrappedGuard?: string
  original?: string
}

function sameFileBytes(left: string, right: string): boolean {
  try {
    return readFileSync(left).equals(readFileSync(right))
  } catch {
    return false
  }
}

function installedRefGuard(installed: string, guard: string): InstalledRefGuard | null {
  if (!pathEntryExists(installed)) return null
  let executable: boolean
  let content: Buffer
  try {
    accessSync(installed, constants.X_OK)
    executable = true
    content = readFileSync(installed)
  } catch {
    try {
      content = readFileSync(installed)
      executable = false
    } catch {
      return null
    }
  }
  if (sameFileBytes(installed, guard)) {
    return { kind: 'guard', content, executable }
  }
  const text = content.toString()
  const marker = text.match(
    /^#!\/bin\/sh\n# orch shared-ref guard wrapper\n# guard-hook-base64: ([A-Za-z0-9+/=]+)\n# original-hook-base64: ([A-Za-z0-9+/=]+)\n/,
  )
  if (!marker) return null
  const wrappedGuard = Buffer.from(marker[1]!, 'base64').toString()
  const original = Buffer.from(marker[2]!, 'base64').toString()
  if (!sameFileBytes(wrappedGuard, guard)) return null
  try {
    accessSync(wrappedGuard, constants.X_OK)
  } catch {
    return null
  }
  return text === sharedRefGuardWrapper(dirname(installed), wrappedGuard, original)
    ? { kind: 'wrapper', content, executable, wrappedGuard, original }
    : null
}

const REF_GUARD_STAGE_PREFIX = '.orch-hooks-'

const UNMARKED_GUARD_PREFIX = 'unmarked-'

/**
 * The guard directory's name. A tree orch cut carries its run id in the
 * marker; a tree built by hand (the lifecycle harness, an operator landing a
 * branch from a tree orch did not cut) has none and gets a key derived from
 * its real path, so concurrent preparations on one tree still converge on one
 * directory. Refusing here would leave a hand-made tree UNGUARDED at
 * the point the guard matters most. Unmarked guards are not reclaimed as
 * litter: nothing records which tree they served once it is gone, and a
 * hand-made tree is rare.
 */
function refGuardOwner(cwd: string): string {
  const value = markedWorktreeRunId(cwd)
  if (value !== null) return String(value)
  let real = cwd
  try {
    real = realpathSync(cwd)
  } catch {
    /* the path as given still keys deterministically */
  }
  return `${UNMARKED_GUARD_PREFIX}${createHash('sha256').update(real).digest('hex').slice(0, 16)}`
}

export function markedWorktreeRunId(cwd: string): number | null {
  try {
    const value = Number(readFileSync(join(cwd, ORCH_RUN_MARKER), 'utf8').split('\n', 1)[0])
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function refGuardCheckpoint(name: string): void {
  if (process.env.ORCH_TEST_REF_GUARD_CHECKPOINT !== name) return
  const ready = process.env.ORCH_TEST_REF_GUARD_READY
  if (!ready) return
  writeFileSync(ready, `${name}\n`)
  for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000)
}

function cleanupRefGuardLitter(gitDir: string, hookDir?: string): void {
  for (const name of readdirSync(gitDir)) {
    if (name.startsWith(REF_GUARD_STAGE_PREFIX)) {
      const pid = Number(name.slice(REF_GUARD_STAGE_PREFIX.length).split('-', 1)[0])
      if (Number.isInteger(pid) && pidAlive(pid)) continue
      rmSync(join(gitDir, name), { recursive: true, force: true })
      continue
    }
    if (!/^\d+$/.test(name)) continue
    const run = db().query(`SELECT status, worktree FROM run WHERE id=?`).get(Number(name)) as {
      status: string
      worktree: string | null
    } | null
    if (
      !run ||
      run.worktree !== null ||
      !['ok', 'failed', 'stale', 'stopped'].includes(run.status)
    ) {
      continue
    }
    rmSync(join(gitDir, name), { recursive: true, force: true })
  }
  if (!hookDir || !pathEntryExists(hookDir) || !lstatSync(hookDir).isDirectory()) return
  for (const name of readdirSync(hookDir)) {
    const temporary = name.match(/^\.reference-transaction-(\d+)-/)
    if (!temporary) continue
    if (temporary && pidAlive(Number(temporary[1]))) continue
    rmSync(join(hookDir, name), { recursive: true, force: true })
  }
}

function stageRefGuardDirectory(
  gitDir: string,
  hookDir: string,
  guard: string,
  wrapper: string | null,
): void {
  const stage = join(gitDir, `${REF_GUARD_STAGE_PREFIX}${process.pid}-${randomUUID()}`)
  const staged = join(stage, 'reference-transaction')
  let fd: number | null = null
  try {
    mkdirSync(stage)
    refGuardCheckpoint('mkdir')
    cleanupRefGuardLitter(gitDir)
    refGuardCheckpoint('cleanup')
    fd = openSync(staged, 'wx', 0o600)
    refGuardCheckpoint('temporary-open')
    writeFileSync(fd, wrapper ?? readFileSync(guard))
    refGuardCheckpoint('write')
    fchmodSync(fd, 0o755)
    refGuardCheckpoint('chmod')
    fsyncSync(fd)
    refGuardCheckpoint('fsync')
    closeSync(fd)
    fd = null
    refGuardCheckpoint('close')
    const directoryFd = openSync(stage, constants.O_RDONLY)
    try {
      fsyncSync(directoryFd)
    } finally {
      closeSync(directoryFd)
    }
    renameSync(stage, hookDir)
  } finally {
    if (fd !== null) closeSync(fd)
    rmSync(stage, { recursive: true, force: true })
  }
}

function verifiedSharedRefGuardEnvironment(
  paths: { commonDir: string },
  hookDir: string,
  guard: string,
  allowedRef?: string,
  readonly = false,
): SharedRefGuardEnvironment {
  const installed = join(hookDir, 'reference-transaction')
  const verified = installedRefGuard(installed, guard)
  if (!verified?.executable) {
    throw new Error(`refusing to expose unverified shared ref guard hooks path: ${hookDir}`)
  }
  if (readonly) installReadOnlyPrePush(hookDir)
  return sharedRefGuardEnvironment(paths, hookDir, allowedRef)
}

function verifiedReadOnlyPrePush(installed: string): boolean {
  if (!pathEntryExists(installed)) return false
  try {
    accessSync(installed, constants.X_OK)
    return readFileSync(installed, 'utf8') === READONLY_PRE_PUSH
  } catch {
    return false
  }
}

function installReadOnlyPrePush(hookDir: string): void {
  const installed = join(hookDir, 'pre-push')
  if (pathEntryExists(installed)) {
    if (verifiedReadOnlyPrePush(installed)) return
    throw new Error(`refusing to replace unrecognized read-only pre-push hook ${installed}`)
  }
  let fd: number | null = null
  try {
    fd = openSync(installed, 'wx', 0o600)
    writeFileSync(fd, READONLY_PRE_PUSH)
    fchmodSync(fd, 0o755)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
  } catch (error) {
    if (fd !== null) closeSync(fd)
    if (verifiedReadOnlyPrePush(installed)) return
    throw error
  }
}

function refGuardPaths(cwd: string, readonlyRepoRoot?: string): { commonDir: string } {
  const linkedPaths = linkedWorktreePaths(cwd)
  if (linkedPaths) return linkedPaths
  const readonlyCommonDir = readonlyRepoRoot ? commonGitDir(readonlyRepoRoot) : null
  if (readonlyCommonDir) return { commonDir: readonlyCommonDir }
  throw new Error(
    readonlyRepoRoot
      ? `cannot guard read-only pushes: ${readonlyRepoRoot} has no common git directory`
      : `cannot guard shared refs: ${cwd} is not a linked worktree`,
  )
}

/** Install the ref-update boundary without changing the shared repository config. */
export function prepareSharedRefGuard(
  cwd: string,
  allowedRef?: string,
  readonlyRepoRoot?: string,
): SharedRefGuardEnvironment {
  const paths = refGuardPaths(cwd, readonlyRepoRoot)
  const readonly = readonlyRepoRoot !== undefined
  const hookDir = join(paths.commonDir, 'orch-guards', refGuardOwner(cwd))
  if (pathEntryExists(hookDir) && realpathSync(hookDir) !== resolve(hookDir)) {
    throw new Error(`refusing shared ref guard hook directory symlink: ${hookDir}`)
  }
  const guardRoot = dirname(hookDir)
  mkdirSync(guardRoot, { recursive: true })
  cleanupRefGuardLitter(guardRoot, hookDir)

  const configured = gitConfigOk(['config', '--path', 'core.hooksPath'], cwd)
  const originalDir = configured
    ? configured.startsWith('/')
      ? configured
      : resolve(cwd, configured)
    : join(paths.commonDir, 'hooks')

  const guard = realpathSync(join(ROOT, 'hooks', 'reference-transaction'))
  const originalReferenceHook = join(originalDir, 'reference-transaction')
  const installed = join(hookDir, 'reference-transaction')
  const installedGuard = installedRefGuard(installed, guard)
  let wrapper: string | null = null

  if (pathEntryExists(originalReferenceHook)) {
    let original: string
    try {
      original = realpathSync(originalReferenceHook)
    } catch {
      throw new Error(
        `refusing shared ref guard wrapper: original hook cannot be resolved: ${originalReferenceHook}`,
      )
    }
    if (resolve(originalReferenceHook) === resolve(installed)) {
      throw new Error(
        `refusing shared ref guard wrapper: original hook resolves to its own path ${installed}`,
      )
    }
    if (original === resolve(installed)) {
      throw new Error(
        `refusing shared ref guard wrapper: original hook resolves to its own path ${installed}`,
      )
    }
    if (sameFileBytes(original, guard)) {
      throw new Error(
        `refusing shared ref guard wrapper: original hook ${originalReferenceHook} ` +
          `resolves to tracked shared guard ${guard}`,
      )
    }
    wrapper = sharedRefGuardWrapper(hookDir, guard, original)
    if (installedGuard?.kind === 'wrapper' && installedGuard.original === original) {
      if (installedGuard.executable) {
        return verifiedSharedRefGuardEnvironment(paths, hookDir, guard, allowedRef, readonly)
      }
    }
    if (pathEntryExists(installed)) {
      let target = installed
      if (lstatSync(installed).isSymbolicLink()) {
        try {
          target = realpathSync(installed)
        } catch {
          target = '(dangling symlink)'
        }
      }
      throw new Error(
        `refusing to replace existing shared ref guard hook ${installed} (resolves to ${target})`,
      )
    }
  } else if (installedGuard !== null) {
    if (installedGuard.executable) {
      return verifiedSharedRefGuardEnvironment(paths, hookDir, guard, allowedRef, readonly)
    }
    throw new Error(`shared ref guard is not executable: ${realpathSync(installed)}`)
  } else if (pathEntryExists(installed)) {
    throw new Error(`refusing to replace unrecognized shared ref guard hook ${installed}`)
  }

  try {
    accessSync(existsSync(hookDir) ? hookDir : guardRoot, constants.W_OK)
  } catch {
    throw new Error(`cannot install shared ref guard: hook path is not writable: ${hookDir}`)
  }
  // core.hooksPath is injected into the worker's process environment, not
  // configured for this repository. It therefore reaches every scratch
  // repository the worker touches. Project hooks such as commit-msg have no
  // business running there, so this directory carries only the ref-update
  // guard. Worker commits do not accidentally inherit checkout-local hooks.
  // The complete directory is assembled and synced under a private sibling
  // name. Only one rename publishes it at the path a worker may receive.
  try {
    stageRefGuardDirectory(guardRoot, hookDir, guard, wrapper)
  } catch (error) {
    if (!pathEntryExists(hookDir)) throw error
    const winner = installedRefGuard(installed, guard)
    const expectedOriginal = wrapper === null ? undefined : realpathSync(originalReferenceHook)
    if (
      !winner?.executable ||
      winner.kind !== (wrapper === null ? 'guard' : 'wrapper') ||
      winner.original !== expectedOriginal
    ) {
      throw new Error(`shared ref guard publication raced with an unsafe hook at ${installed}`)
    }
  }

  return verifiedSharedRefGuardEnvironment(paths, hookDir, guard, allowedRef, readonly)
}

/** Remove the guard owned by one run. A missing repository or directory is already clean. */
export function removeSharedRefGuard(cwd: string, runId: number): void {
  const commonDir = commonGitDir(cwd)
  if (!commonDir) return
  rmSync(join(commonDir, 'orch-guards', String(runId)), { recursive: true, force: true })
}

/**
 * Refuse dispatch if the worker can write the hook that constrains its shared ref writes.
 * Existing paths are canonicalised before containment is compared so symlinks cannot
 * make a writable ancestor look unrelated to the published directory.
 */
export function assertSharedRefGuardOutsideWritableRoots(
  hookDir: string,
  writableRoots: string[],
): void {
  const published = realpathSync(hookDir)
  for (const root of writableRoots) {
    const canonicalRoot = realpathSync(root)
    const rel = relative(canonicalRoot, published)
    if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
      throw new Error(
        `THE GUARD LIVES OUTSIDE EVERY ROOT THE WORKER CAN WRITE invariant failed: ` +
          `${published} is inside writable root ${canonicalRoot}`,
      )
    }
  }
}

function sharedRefGuardEnvironment(
  paths: { commonDir: string },
  hookDir: string,
  allowedRef?: string,
): SharedRefGuardEnvironment {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hookDir,
    ORCH_GUARDED_GIT_COMMON_DIR: paths.commonDir,
    ...(allowedRef ? { ORCH_ALLOWED_GIT_REF: allowedRef } : {}),
  }
}

/**
 * Common immutable objects plus the run branch's ref/reflog directories are the only shared writes.
 * A flat branch necessarily grants all of refs/heads and logs/refs/heads. That is acceptable only
 * because the guard is outside those roots and refuses every ref except the worker's exact branch.
 */
export function workerSharedGitRoots(cwd: string, branch: string): string[] {
  const paths = linkedWorktreePaths(cwd)
  if (!paths) throw new Error(`cannot resolve shared git roots: ${cwd} is not a linked worktree`)
  const ref = resolve(paths.commonDir, 'refs', 'heads', ...branch.split('/'))
  const reflog = resolve(paths.commonDir, 'logs', 'refs', 'heads', ...branch.split('/'))
  return [join(paths.commonDir, 'objects'), dirname(ref), dirname(reflog)]
}
