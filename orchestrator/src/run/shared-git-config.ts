// concern: writing-run shared git config containment
/** Snapshots, decides, repairs, and reports writing-run changes to a project's shared config. */

import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runScratchDir } from '../artifact-paths.ts'
import { resolveRunsDirectory } from '../database/database-location.ts'
import { recordRunWarning } from '../events.ts'
import { commonGitDir, targetGitEnvironment } from '../git/git-environment.ts'

export const SHARED_GIT_CONFIG_SNAPSHOT_FILE = 'shared-git-config-snapshot.json'

export type GitConfigValues = Readonly<Record<string, readonly string[]>>
export type SharedGitConfigSnapshot =
  | { ok: true; configPath: string; values: GitConfigValues }
  | { ok: false; configPath: string | null; error: string }

export type SharedGitConfigAction = {
  kind: 'repair' | 'report'
  change: 'added' | 'changed' | 'removed'
  key: string
  namesRunTree: boolean
  oldValues: readonly string[]
  newValues: readonly string[]
}

function valuesEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function namesRunTree(value: string, worktree: string): boolean {
  if (!isAbsolute(value)) return false
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
  const values: Record<string, string[]> = {}
  for (const entry of output.split('\0')) {
    if (!entry) continue
    const separator = entry.indexOf('\n')
    const key = separator < 0 ? entry : entry.slice(0, separator)
    if (!key) throw new Error('git config returned an empty key')
    const keyValues = values[key] ?? []
    keyValues.push(separator < 0 ? '' : entry.slice(separator + 1))
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

/** Capture and persist the exact common-dir config before a writing worker can run project code. */
export function snapshotWritingRunSharedGitConfig(input: {
  writesJob: boolean
  worktree: string | null
  scratchDir: string
}): SharedGitConfigSnapshot | null {
  if (!shouldSnapshotSharedGitConfig(input.writesJob, input.worktree)) return null
  const snapshot = snapshotSharedGitConfig(input.worktree!)
  try {
    writeFileSync(
      join(input.scratchDir, SHARED_GIT_CONFIG_SNAPSHOT_FILE),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      { mode: 0o600 },
    )
    return snapshot
  } catch (error) {
    return {
      ok: false,
      configPath: snapshot.configPath,
      error: `could not persist shared git config snapshot: ${String((error as Error)?.message ?? error)}`,
    }
  }
}

function readSnapshotArtifact(scratchDir: string): SharedGitConfigSnapshot {
  const path = join(scratchDir, SHARED_GIT_CONFIG_SNAPSHOT_FILE)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as SharedGitConfigSnapshot
    if (parsed?.ok === true && typeof parsed.configPath === 'string' && parsed.values) return parsed
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

function missingOldValues(action: SharedGitConfigAction, retained: readonly string[]): string[] {
  const available = [...retained]
  const missing: string[] = []
  for (const value of action.oldValues) {
    const index = available.indexOf(value)
    if (index >= 0) available.splice(index, 1)
    else missing.push(value)
  }
  return missing
}

function restoreKey(
  configPath: string,
  action: SharedGitConfigAction,
  worktree: string,
): string | null {
  const offending = new Set(action.newValues.filter((value) => namesRunTree(value, worktree)))
  for (const value of offending) {
    const removed = gitConfig(configPath, ['--unset-all', action.key, exactValuePattern(value)])
    if (!removed.ok) return removed.error
  }
  const retained = action.newValues.filter((value) => !namesRunTree(value, worktree))
  const restore = missingOldValues(action, retained)
  for (const value of restore) {
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

/** Compare at terminal, repair only run-tree paths, and leave all other changes visible. */
export function terminalSharedGitConfigHeader(input: {
  runId: string
  worktree: string | null
  scratchDir: string
  expected: boolean
}): string | null {
  if (!input.expected || !input.worktree) return null
  const snapshot = readSnapshotArtifact(input.scratchDir)
  if (!snapshot.ok) {
    recordRunWarning(input.runId, `shared git config check could not run: ${snapshot.error}`)
    return null
  }
  let after: GitConfigValues
  try {
    after = readSharedGitConfig(snapshot.configPath)
  } catch (error) {
    recordRunWarning(
      input.runId,
      `shared git config check could not compare ${snapshot.configPath}: ${String((error as Error)?.message ?? error)}`,
    )
    return null
  }
  const headers: string[] = []
  for (const action of decideSharedGitConfigChanges(snapshot.values, after, input.worktree)) {
    const description = actionDescription(action, snapshot.configPath)
    if (action.kind === 'report') {
      const detail = `shared git config changed: ${description}`
      recordRunWarning(input.runId, detail)
      headers.push(detail)
      continue
    }
    const repairError = restoreKey(snapshot.configPath, action, input.worktree)
    if (repairError) {
      const detail = `shared git config repair failed for ${action.key} in ${snapshot.configPath}`
      recordRunWarning(input.runId, `${detail}: ${repairError}`)
      headers.push(detail)
    } else {
      recordRunWarning(input.runId, `shared git config repaired: ${description}`)
    }
  }
  return headers.length ? headers.join('\n') : null
}

/** Bind run identity and the default artifact layout at lifecycle adapter boundaries. */
export function terminalSharedGitConfigForRun(input: {
  runId: string
  writesJob: boolean
  worktree: string | null
}): string | null {
  return terminalSharedGitConfigHeader({
    runId: input.runId,
    worktree: input.worktree,
    scratchDir: runScratchDir(input.runId, resolveRunsDirectory(process.env)),
    expected: input.writesJob && Boolean(input.worktree),
  })
}
