// concern: writing-run shared git config containment
/** Snapshots, decides, repairs, and reports writing-run changes to a project's shared config. */

import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { recordRunWarning } from '../events.ts'
import { commonGitDir, targetGitEnvironment } from '../git/git-environment.ts'
import type { Worktree } from '../worktree/worktree-types.ts'

export type GitConfigValues = Readonly<Record<string, readonly string[]>>

export type SharedGitConfigSnapshot =
  | { ok: true; configPath: string; values: GitConfigValues }
  | { ok: false; configPath: string | null; error: string }

export type SharedGitConfigAction = {
  kind: 'repair' | 'report'
  key: string
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
    actions.push({
      kind: newValues.some((value) => namesRunTree(value, worktree)) ? 'repair' : 'report',
      key,
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

function parseConfigList(output: string): GitConfigValues {
  const values: Record<string, string[]> = {}
  for (const entry of output.split('\0')) {
    if (!entry) continue
    const separator = entry.indexOf('\n')
    if (separator < 0) throw new Error('git config returned a key without a value separator')
    const key = entry.slice(0, separator)
    const keyValues = values[key] ?? []
    keyValues.push(entry.slice(separator + 1))
    values[key] = keyValues
  }
  return values
}

function readSharedGitConfig(configPath: string): GitConfigValues {
  const result = gitConfig(configPath, ['--list', '--null'])
  if (!result.ok) throw new Error(result.error)
  return parseConfigList(result.stdout)
}

/** Capture the exact common-dir config before a writing worker can run project code. */
export function snapshotSharedGitConfig(worktree: string): SharedGitConfigSnapshot {
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

/** Snapshot only the writing runs that can execute project code in a worktree. */
export function snapshotWritingRunSharedGitConfig(
  writesJob: boolean,
  worktree: Worktree | null,
): SharedGitConfigSnapshot | null {
  if (!writesJob || !worktree) return null
  return snapshotSharedGitConfig(worktree.path)
}

function formatValues(values: readonly string[]): string {
  return values.length ? JSON.stringify(values.length === 1 ? values[0] : values) : '(absent)'
}

function restoreKey(configPath: string, action: SharedGitConfigAction): string | null {
  const removed = gitConfig(configPath, ['--unset-all', action.key])
  if (!removed.ok && removed.code !== 5) return removed.error
  for (const value of action.oldValues) {
    const restored = gitConfig(configPath, ['--add', action.key, value])
    if (!restored.ok) return restored.error
  }
  return null
}

export type SharedGitConfigCheck = { header: string | null }

/** Compare at terminal, repair only run-tree paths, and leave all other changes visible. */
export function checkSharedGitConfigAtTerminal(input: {
  runId: string
  worktree: string
  snapshot: SharedGitConfigSnapshot
}): SharedGitConfigCheck {
  if (!input.snapshot.ok) {
    recordRunWarning(input.runId, `shared git config check could not run: ${input.snapshot.error}`)
    return { header: null }
  }
  let after: GitConfigValues
  try {
    after = readSharedGitConfig(input.snapshot.configPath)
  } catch (error) {
    recordRunWarning(
      input.runId,
      `shared git config check could not compare ${input.snapshot.configPath}: ${String((error as Error)?.message ?? error)}`,
    )
    return { header: null }
  }
  const reports: string[] = []
  for (const action of decideSharedGitConfigChanges(input.snapshot.values, after, input.worktree)) {
    if (action.kind === 'report') {
      const detail =
        `shared git config changed: ${action.key}; old=${formatValues(action.oldValues)}; ` +
        `new=${formatValues(action.newValues)}; config=${input.snapshot.configPath}`
      recordRunWarning(input.runId, detail)
      reports.push(detail)
      continue
    }
    const repairError = restoreKey(input.snapshot.configPath, action)
    const detail = repairError
      ? `shared git config repair failed: ${action.key}; old=${formatValues(action.oldValues)}; new=${formatValues(action.newValues)}; config=${input.snapshot.configPath}; error=${repairError}`
      : `shared git config repaired: ${action.key}; old=${formatValues(action.oldValues)}; new=${formatValues(action.newValues)}; config=${input.snapshot.configPath}`
    recordRunWarning(input.runId, detail)
  }
  return { header: reports.length ? reports.join('\n') : null }
}

/** Run the terminal check only when dispatch captured a writing worktree. */
export function terminalSharedGitConfigHeader(input: {
  runId: string
  worktree: Worktree | null
  snapshot: SharedGitConfigSnapshot | null
}): string | null {
  if (!input.worktree || !input.snapshot) return null
  return checkSharedGitConfigAtTerminal({
    runId: input.runId,
    worktree: input.worktree.path,
    snapshot: input.snapshot,
  }).header
}
