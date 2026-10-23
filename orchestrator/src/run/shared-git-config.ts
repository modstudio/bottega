// concern: writing-run shared git config containment
/** Snapshots, decides, repairs, and reports writing-run changes to a project's shared config. */

import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resolveRunsDirectory } from '../database/database-location.ts'
import { recordRunWarning } from '../events.ts'
import { commonGitDir, targetGitEnvironment } from '../git/git-environment.ts'
import { assertOrchestratorOwnedPathsOutsideWritableRoots } from '../resources/ref-guard.ts'

const SHARED_GIT_CONFIG_SNAPSHOT_FILE = 'shared-git-config-snapshot.json'

/** null is Git's valueless/implicit-true form; '' is an explicit empty value. */
type GitConfigValue = string | null
export type GitConfigValues = Readonly<Record<string, readonly GitConfigValue[]>>
export type SharedGitConfigSnapshot =
  | { ok: true; configPath: string; values: GitConfigValues }
  | { ok: false; configPath: string | null; error: string }

export type SharedGitConfigAction = {
  kind: 'repair' | 'report'
  change: 'added' | 'changed' | 'removed'
  key: string
  namesRunTree: boolean
  oldValues: readonly GitConfigValue[]
  newValues: readonly GitConfigValue[]
}

function valuesEqual(left: readonly GitConfigValue[], right: readonly GitConfigValue[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function namesRunTree(value: GitConfigValue, worktree: string): boolean {
  if (value === null || !isAbsolute(value)) return false
  const rel = relative(resolve(worktree), resolve(value))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Classify changed keys without reading files or applying repairs. */
export function decideSharedGitConfigChanges(
  before: GitConfigValues,
  after: GitConfigValues,
  worktree: string,
): SharedGitConfigAction[] {
  const actions: SharedGitConfigAction[] = []
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const oldValues = before[key] ?? []
    const newValues = after[key] ?? []
    if (valuesEqual(oldValues, newValues)) continue
    const runTreeValue = newValues.some((value) => namesRunTree(value, worktree))
    actions.push({
      kind: runTreeValue ? 'repair' : 'report',
      change: oldValues.length === 0 ? 'added' : newValues.length === 0 ? 'removed' : 'changed',
      key,
      namesRunTree: runTreeValue,
      oldValues,
      newValues,
    })
  }
  return actions
}

function gitConfig(
  configPath: string,
  args: string[],
): { ok: boolean; code: number | null; stdout: string; error: string } {
  const result = Bun.spawnSync(['git', 'config', '--file', configPath, ...args], {
    env: targetGitEnvironment(configPath),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    ok: result.exitCode === 0,
    code: result.exitCode,
    stdout: result.stdout.toString(),
    error:
      result.stderr.toString().trim() || `git config ${args[0] ?? ''} exited ${result.exitCode}`,
  }
}

/** Parse git's NUL-separated `--list --null` output, including valueless keys. */
export function parseConfigList(output: string): GitConfigValues {
  const values: Record<string, GitConfigValue[]> = {}
  for (const entry of output.split('\0')) {
    if (!entry) continue
    const separator = entry.indexOf('\n')
    const key = separator < 0 ? entry : entry.slice(0, separator)
    if (!key) throw new Error('git config returned an empty key')
    const keyValues = values[key] ?? []
    keyValues.push(separator < 0 ? null : entry.slice(separator + 1))
    values[key] = keyValues
  }
  return values
}

function readSharedGitConfig(configPath: string): GitConfigValues {
  const result = gitConfig(configPath, ['--list', '--null'])
  if (!result.ok) throw new Error(result.error)
  return parseConfigList(result.stdout)
}

function snapshotSharedGitConfig(worktree: string): SharedGitConfigSnapshot {
  const commonDir = commonGitDir(worktree)
  if (!commonDir) {
    return {
      ok: false,
      configPath: null,
      error: `could not resolve git common dir for ${worktree}`,
    }
  }
  const configPath = join(commonDir, 'config')
  try {
    return { ok: true, configPath, values: readSharedGitConfig(configPath) }
  } catch (error) {
    return { ok: false, configPath, error: String((error as Error)?.message ?? error) }
  }
}

/** Pure dispatch gate for the runs whose project code can mutate shared config. */
export function shouldSnapshotSharedGitConfig(
  writesJob: boolean,
  worktree: string | null,
): boolean {
  return writesJob && worktree !== null
}

export function sharedGitConfigSnapshotPath(
  runId: string,
  runsDir = resolveRunsDirectory(process.env),
): string {
  return join(runsDir, runId, SHARED_GIT_CONFIG_SNAPSHOT_FILE)
}

/** Capture and persist the exact common-dir config before a writing worker can run project code. */
export function snapshotWritingRunSharedGitConfig(input: {
  runId: string
  writesJob: boolean
  worktree: string | null
  writableRoots: string[]
  runsDir?: string
}): SharedGitConfigSnapshot | null {
  if (!shouldSnapshotSharedGitConfig(input.writesJob, input.worktree)) return null
  const path = sharedGitConfigSnapshotPath(input.runId, input.runsDir)
  assertOrchestratorOwnedPathsOutsideWritableRoots(
    [path],
    input.writableRoots,
    'THE SHARED GIT CONFIG SNAPSHOT LIVES OUTSIDE EVERY ROOT THE WORKER CAN WRITE',
  )
  const snapshot = snapshotSharedGitConfig(input.worktree!)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
    return snapshot
  } catch (error) {
    return {
      ok: false,
      configPath: snapshot.configPath,
      error: `could not persist shared git config snapshot: ${String((error as Error)?.message ?? error)}`,
    }
  }
}

function validConfigValues(value: unknown): value is GitConfigValues {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.entries(value as Record<string, unknown>).every(
      ([key, entries]) =>
        key.length > 0 &&
        Array.isArray(entries) &&
        entries.every((entry) => entry === null || typeof entry === 'string'),
    )
  )
}

function readSnapshotArtifact(path: string): SharedGitConfigSnapshot {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SharedGitConfigSnapshot
    if (
      parsed?.ok === true &&
      typeof parsed.configPath === 'string' &&
      validConfigValues(parsed.values)
    )
      return parsed
    if (parsed?.ok === false && 'configPath' in parsed && typeof parsed.error === 'string')
      return parsed
    throw new Error('snapshot JSON has an unknown shape')
  } catch (error) {
    return {
      ok: false,
      configPath: null,
      error: `could not read ${path}: ${String((error as Error)?.message ?? error)}`,
    }
  }
}

function exactValuePattern(value: string): string {
  return `^${value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`
}

function missingOldValues(
  action: SharedGitConfigAction,
  retained: readonly GitConfigValue[],
): GitConfigValue[] {
  const available = [...retained]
  const missing: GitConfigValue[] = []
  for (const value of action.oldValues) {
    const index = available.indexOf(value)
    if (index >= 0) available.splice(index, 1)
    else missing.push(value)
  }
  return missing
}

/** Name repairs that Git's config CLI cannot reproduce before making any mutation. */
export function sharedGitConfigRepairRefusal(
  action: SharedGitConfigAction,
  worktree: string,
): string | null {
  const retained = action.newValues.filter((value) => !namesRunTree(value, worktree))
  return missingOldValues(action, retained).includes(null)
    ? 'cannot restore a valueless config entry'
    : null
}

function restoreKey(
  configPath: string,
  action: SharedGitConfigAction,
  worktree: string,
): string | null {
  const retained = action.newValues.filter((value) => !namesRunTree(value, worktree))
  const restore = missingOldValues(action, retained)
  const refusal = sharedGitConfigRepairRefusal(action, worktree)
  if (refusal) return refusal
  const offending = new Set(action.newValues.filter((value) => namesRunTree(value, worktree)))
  for (const value of offending) {
    if (value === null) continue
    const removed = gitConfig(configPath, ['--unset-all', action.key, exactValuePattern(value)])
    if (!removed.ok && removed.code !== 5) return removed.error
  }
  for (const value of restore) {
    if (value === null) continue
    const restored = gitConfig(configPath, ['--add', action.key, value])
    if (!restored.ok) return restored.error
  }
  let verified: GitConfigValues
  try {
    verified = readSharedGitConfig(configPath)
  } catch (error) {
    return String((error as Error)?.message ?? error)
  }
  const expected = [...retained, ...restore]
  if (!valuesEqual(verified[action.key] ?? [], expected))
    return 'config values did not match after repair'
  return null
}

function actionDescription(action: SharedGitConfigAction, configPath: string): string {
  return `${action.key} (${action.change}; value names run tree: ${action.namesRunTree ? 'yes' : 'no'}) in ${configPath}`
}

function validatedTerminalConfigTarget(
  runId: string,
  worktree: string,
  storedPath: string,
): string | null {
  const commonDir = commonGitDir(worktree)
  const target = commonDir ? join(commonDir, 'config') : null
  if (!target || target !== storedPath) {
    recordRunWarning(
      runId,
      `shared git config check could not run: stored config path does not match the run worktree's common config`,
    )
    return null
  }
  try {
    if (lstatSync(target).isSymbolicLink()) {
      recordRunWarning(runId, `shared git config check could not run: ${target} is a symlink`)
      return null
    }
  } catch (error) {
    recordRunWarning(
      runId,
      `shared git config check could not run: could not inspect ${target}: ${String((error as Error)?.message ?? error)}`,
    )
    return null
  }
  return target
}

function terminalConfigValues(runId: string, target: string): GitConfigValues | null {
  try {
    return readSharedGitConfig(target)
  } catch (error) {
    recordRunWarning(
      runId,
      `shared git config check could not compare ${target}: ${String((error as Error)?.message ?? error)}`,
    )
    return null
  }
}

/** Compare at terminal, repair only run-tree paths, and leave all other changes visible. */
export function terminalSharedGitConfigHeader(input: {
  runId: string
  worktree: string | null
  expected: boolean
  runsDir?: string
}): string | null {
  if (!input.expected || !input.worktree) return null
  const snapshotPath = sharedGitConfigSnapshotPath(input.runId, input.runsDir)
  try {
    const snapshot = readSnapshotArtifact(snapshotPath)
    if (!snapshot.ok) {
      recordRunWarning(input.runId, `shared git config check could not run: ${snapshot.error}`)
      return null
    }
    const target = validatedTerminalConfigTarget(input.runId, input.worktree, snapshot.configPath)
    if (!target) return null
    const after = terminalConfigValues(input.runId, target)
    if (!after) return null
    const headers: string[] = []
    for (const action of decideSharedGitConfigChanges(snapshot.values, after, input.worktree)) {
      const description = actionDescription(action, target)
      if (action.kind === 'report') {
        const detail = `shared git config changed: ${description}`
        recordRunWarning(input.runId, detail)
        headers.push(detail)
        continue
      }
      const repairError = restoreKey(target, action, input.worktree)
      if (repairError) {
        const detail = `shared git config repair failed for ${action.key} in ${target}`
        recordRunWarning(input.runId, detail)
        headers.push(detail)
      } else {
        recordRunWarning(input.runId, `shared git config repaired: ${description}`)
      }
    }
    return headers.length ? headers.join('\n') : null
  } finally {
    try {
      unlinkSync(snapshotPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        recordRunWarning(
          input.runId,
          `shared git config snapshot cleanup failed for ${snapshotPath}`,
        )
    }
  }
}
