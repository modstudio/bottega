/**
 * Observation-only inventory of recipe databases, retained-branch refs, and
 * shared ref-guard metadata. The monitor reports what it finds; nothing here
 * drops a database or deletes a ref.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { db } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { isProjectRepository, projects } from '../project/projects.ts'
import { RUNS_DIR } from '../run/run-artifacts.ts'

const RESOURCE_INVENTORY_TIMEOUT_MS = 1_000

type WorktreeDatabase = {
  engine: 'postgres' | 'mysql'
  name: string
  runId: number
  project: string
}

export type DatabaseInventory =
  | { ascertainable: true; databases: WorktreeDatabase[] }
  | { ascertainable: false; reason: string }

export type RetainedRef = {
  ref: string
  sha: string
  runId: number
  project: string
}

export type RefGuard = {
  path: string
  runId: number
  project: string
}

export type GitResourceInventory<T> =
  | { ascertainable: true; items: T[] }
  | { ascertainable: false; reason: string }

export type SandboxDirectoryInventory =
  | {
      ascertainable: true
      directories: { rootId: number; path: string; sizeBytes: number }[]
      conversations: { rootId: number; terminal: boolean }[]
    }
  | { ascertainable: false; reason: string }

function directorySize(path: string): number {
  const entry = lstatSync(path)
  if (!entry.isDirectory()) return entry.size
  return readdirSync(path).reduce((total, name) => total + directorySize(join(path, name)), 0)
}

/** Inventory sandbox homes and their recorded conversation state. Never removes them. */
export function sandboxDirectoryInventory(
  database: ReturnType<typeof db>,
): SandboxDirectoryInventory {
  try {
    const directories = existsSync(RUNS_DIR)
      ? readdirSync(RUNS_DIR, { withFileTypes: true }).flatMap((entry) => {
          const match = entry.isDirectory() ? /^sandbox-([1-9]\d*)$/.exec(entry.name) : null
          if (!match) return []
          const path = join(RUNS_DIR, entry.name)
          return [{ rootId: Number(match[1]), path, sizeBytes: directorySize(path) }]
        })
      : []
    const rows = database.query('SELECT id, parent_run_id, status FROM run').all() as {
      id: number
      parent_run_id: number | null
      status: string
    }[]
    const statuses = new Map<number, string[]>()
    for (const row of rows) {
      const rootId = row.parent_run_id ?? row.id
      statuses.set(rootId, [...(statuses.get(rootId) ?? []), row.status])
    }
    const terminal = new Set(['ok', 'failed', 'stale', 'stopped'])
    return {
      ascertainable: true,
      directories,
      conversations: [...statuses].map(([rootId, values]) => ({
        rootId,
        terminal: values.length > 0 && values.every((status) => terminal.has(status)),
      })),
    }
  } catch (error) {
    return {
      ascertainable: false,
      reason: `sandbox directory inventory unavailable: ${(error as Error).message}`,
    }
  }
}

/** Names bottega derives for recipe databases end in `_wt_<runId>`. */
function parseWorktreeDatabaseName(name: string): number | null {
  const match = name.match(/_wt_([1-9]\d*)$/)
  return match ? Number(match[1]) : null
}

function parseRetainedRef(ref: string): number | null {
  const match = ref.match(/^refs\/orch\/retained\/([1-9]\d*)$/)
  return match ? Number(match[1]) : null
}

function parseRefGuardRunId(name: string): number | null {
  if (!/^[1-9]\d*$/.test(name)) return null
  return Number(name)
}

function databasesFromNames(
  project: string,
  engine: 'postgres' | 'mysql',
  names: string[],
): WorktreeDatabase[] {
  return names.flatMap((name) => {
    const runId = parseWorktreeDatabaseName(name)
    return runId === null ? [] : [{ engine, name, runId, project }]
  })
}

function listCommand(
  argv: string[],
  cwd: string,
): { ascertainable: true; names: string[] } | { ascertainable: false; reason: string } {
  let p: ReturnType<typeof Bun.spawnSync>
  try {
    p = Bun.spawnSync(argv, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: RESOURCE_INVENTORY_TIMEOUT_MS,
    })
  } catch (error) {
    return {
      ascertainable: false,
      reason: `${argv[0]} inventory unavailable: ${(error as Error).message}`,
    }
  }
  if (p.exitedDueToTimeout) {
    return {
      ascertainable: false,
      reason: `${argv[0]} inventory unavailable: timed out after ${RESOURCE_INVENTORY_TIMEOUT_MS}ms`,
    }
  }
  if (p.exitCode !== 0) {
    const detail = p.stderr?.toString().trim() || `exit ${p.exitCode}`
    return { ascertainable: false, reason: `${argv[0]} inventory unavailable: ${detail}` }
  }
  return {
    ascertainable: true,
    names: (p.stdout?.toString() ?? '')
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean),
  }
}

/** Inventory recipe-provisioned Postgres and MySQL databases. Never mutates them. */
export function worktreeDatabaseInventory(): DatabaseInventory {
  const databases: WorktreeDatabase[] = []
  for (const project of projects().filter(isProjectRepository)) {
    const provider = project.settings.worktree?.recipe?.database
    if (!provider || (provider.kind !== 'postgres-template' && provider.kind !== 'mysql-dump'))
      continue
    if (provider.kind === 'postgres-template') {
      const psql = provider.psql ?? 'psql'
      const listed = listCommand(
        [
          psql,
          '-v',
          'ON_ERROR_STOP=1',
          '-tAc',
          'SELECT datname FROM pg_database WHERE datistemplate = false',
        ],
        project.path,
      )
      if (!listed.ascertainable) return listed
      databases.push(...databasesFromNames(project.name, 'postgres', listed.names))
    } else {
      const mysql = provider.mysql ?? 'mysql'
      const listed = listCommand([mysql, '-N', '-e', 'SHOW DATABASES'], project.path)
      if (!listed.ascertainable) return listed
      databases.push(...databasesFromNames(project.name, 'mysql', listed.names))
    }
  }
  return { ascertainable: true, databases }
}

function git(
  cwd: string,
  args: string[],
): { ok: true; out: string } | { ok: false; reason: string } {
  let p: ReturnType<typeof Bun.spawnSync>
  try {
    p = Bun.spawnSync(['git', ...args], {
      cwd,
      env: targetGitEnvironment(cwd),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: RESOURCE_INVENTORY_TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, reason: `git inventory unavailable: ${(error as Error).message}` }
  }
  if (p.exitedDueToTimeout) {
    return {
      ok: false,
      reason: `git inventory unavailable: timed out after ${RESOURCE_INVENTORY_TIMEOUT_MS}ms`,
    }
  }
  if (p.exitCode !== 0) {
    const detail = p.stderr?.toString().trim() || `exit ${p.exitCode}`
    return { ok: false, reason: `git inventory unavailable: ${detail}` }
  }
  return { ok: true, out: (p.stdout?.toString() ?? '').trim() }
}

/** Inventory `refs/orch/retained/<run>` pins left after close-out. Never deletes them. */
export function retainedRefInventory(): GitResourceInventory<RetainedRef> {
  const items: RetainedRef[] = []
  for (const project of projects().filter(isProjectRepository)) {
    if (!existsSync(project.path)) continue
    const listed = git(project.path, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/orch/retained',
    ])
    if (!listed.ok) return { ascertainable: false, reason: `${project.name}: ${listed.reason}` }
    if (!listed.out) continue
    for (const line of listed.out.split('\n')) {
      const [ref, sha] = line.split(' ')
      if (!ref || !sha) continue
      const runId = parseRetainedRef(ref)
      if (runId === null) continue
      items.push({ ref, sha, runId, project: project.name })
    }
  }
  return { ascertainable: true, items }
}

/** Inventory `.git/orch-guards/<run>` directories. Never removes them. */
export function refGuardInventory(): GitResourceInventory<RefGuard> {
  const items: RefGuard[] = []
  for (const project of projects().filter(isProjectRepository)) {
    if (!existsSync(project.path)) continue
    const common = git(project.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    if (!common.ok) return { ascertainable: false, reason: `${project.name}: ${common.reason}` }
    if (!common.out) continue
    let root: string
    try {
      root = realpathSync(join(common.out, 'orch-guards'))
    } catch {
      continue
    }
    if (!existsSync(root)) continue
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch (error) {
      return {
        ascertainable: false,
        reason: `${project.name} ref-guard inventory unavailable: ${(error as Error).message}`,
      }
    }
    for (const name of entries) {
      const runId = parseRefGuardRunId(name)
      if (runId === null) continue
      const path = join(root, name)
      try {
        if (!statSync(path).isDirectory()) continue
      } catch {
        continue
      }
      items.push({ path, runId, project: project.name })
    }
  }
  return { ascertainable: true, items }
}
