/**
 * Observation-only inventory of recipe databases, retained-branch refs, and
 * shared ref-guard metadata. The monitor reports what it finds; nothing here
 * drops a database or deletes a ref.
 */
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import type {
  FilesystemIdentityPlan,
  FilesystemIdentityProject,
  FilesystemIdentityRun,
} from '../filesystem-identity-plan.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { isProjectRepository, type Project, projects } from '../project/projects.ts'
import { RUNS_DIR } from '../run/run-artifacts.ts'

const RESOURCE_INVENTORY_TIMEOUT_MS = 1_000

type WorktreeDatabase = {
  engine: 'postgres' | 'mysql'
  name: string
  runId: string
  project: string
}

export type DatabaseInventory =
  | { ascertainable: true; databases: WorktreeDatabase[] }
  | { ascertainable: false; reason: string }

export type RetainedRef = {
  ref: string
  sha: string
  runId: string
  project: string
}

export type RefGuard = {
  path: string
  runId: string
  project: string
}

export type GitResourceInventory<T> =
  | { ascertainable: true; items: T[] }
  | { ascertainable: false; reason: string }

export type SandboxDirectoryInventory =
  | {
      ascertainable: true
      directories: { rootId: string; path: string; sizeBytes: number }[]
      conversations: { rootId: string; terminal: boolean }[]
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
    const rows = database
      .query('SELECT record_id, parent_run_record_id, status FROM run')
      .all() as {
      record_id: string
      parent_run_record_id: string | null
      status: string
    }[]
    const rootRecordIds = new Set(
      database
        .query<{ record_id: string }, []>('SELECT record_id FROM run')
        .all()
        .map((row) => row.record_id),
    )
    const directories = existsSync(RUNS_DIR)
      ? readdirSync(RUNS_DIR, { withFileTypes: true }).flatMap((entry) => {
          const match = entry.isDirectory() ? /^sandbox-([0-9a-f-]{36})$/i.exec(entry.name) : null
          const rootId = match?.[1]?.toLowerCase()
          if (!rootId || !rootRecordIds.has(rootId)) return []
          const path = join(RUNS_DIR, entry.name)
          return [{ rootId, path, sizeBytes: directorySize(path) }]
        })
      : []
    const statuses = new Map<string, string[]>()
    for (const row of rows) {
      const rootId = row.parent_run_record_id ?? row.record_id
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

export function parseRetainedRef(ref: string): string | null {
  const value = ref.match(/^refs\/orch\/retained\/([^/]+)$/)?.[1]
  return value && hasRecordIdShape(value) ? value.toLowerCase() : null
}

function parseRefGuardRunId(name: string): string | null {
  return hasRecordIdShape(name) ? name.toLowerCase() : null
}

const retainedRefName = (recordId: string): string => `refs/orch/retained/${recordId}`
const legacyRetainedRefNumber = (ref: string): string | null =>
  /^refs\/orch\/retained\/([1-9]\d*)$/.exec(ref)?.[1] ?? null
export type RetainedRefMigrationCandidate = {
  projectPath: string
  ref: string
  tip: string
  destinationTip: string | null
}

type RetainedRefMigrationPayload = {
  projectPath: string
  sourceRef: string
  tip: string
  destinationTip: string | null
}

export function planRetainedRefMigration(
  candidates: readonly RetainedRefMigrationCandidate[],
  runs: ReadonlyMap<string, FilesystemIdentityRun>,
): FilesystemIdentityPlan<RetainedRefMigrationPayload> {
  const plan: FilesystemIdentityPlan<RetainedRefMigrationPayload> = {
    mapped: [],
    collisions: [],
    unmapped: [],
  }
  for (const candidate of candidates) {
    const number = legacyRetainedRefNumber(candidate.ref)
    if (!number) continue
    const source = `${candidate.projectPath}:${candidate.ref}`
    const run = runs.get(number)
    if (!run) {
      plan.unmapped.push({ source, number })
      continue
    }
    const move = {
      source,
      destination: retainedRefName(run.recordId),
      run,
      payload: {
        projectPath: candidate.projectPath,
        sourceRef: candidate.ref,
        tip: candidate.tip,
        destinationTip: candidate.destinationTip,
      },
    }
    ;(candidate.destinationTip === null || candidate.destinationTip === candidate.tip
      ? plan.mapped
      : plan.collisions
    ).push(move)
  }
  return plan
}

function repositoryCheckoutState(project: FilesystemIdentityProject): 'absent' | 'checkout' {
  if (!existsSync(project.path)) return 'absent'
  try {
    if (!lstatSync(join(project.path, '.git'))) return 'absent'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw new Error(
      `${project.name}: repository metadata could not be read: ${(error as Error).message}`,
    )
  }
  return 'checkout'
}

export function discoverRetainedRefMigration(
  projectPaths: readonly FilesystemIdentityProject[],
  runs: ReadonlyMap<string, FilesystemIdentityRun>,
): FilesystemIdentityPlan<RetainedRefMigrationPayload> {
  const candidates: RetainedRefMigrationCandidate[] = []
  for (const project of projectPaths) {
    if (repositoryCheckoutState(project) === 'absent') continue
    const refs = git(project.path, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/orch/retained',
    ])
    if (!refs.ok) {
      throw new Error(`${project.name}: retained refs could not be read: ${refs.reason}`)
    }
    const observedRefs = new Map(
      (refs.out ? refs.out.split('\n') : []).flatMap((line) => {
        const [ref, tip] = line.split(' ')
        return ref && tip ? [[ref, tip] as const] : []
      }),
    )
    for (const [ref, tip] of observedRefs) {
      if (!ref || !tip) continue
      const number = legacyRetainedRefNumber(ref)
      const run = number ? runs.get(number) : undefined
      candidates.push({
        projectPath: project.path,
        ref,
        tip,
        destinationTip: run ? (observedRefs.get(retainedRefName(run.recordId)) ?? null) : null,
      })
    }
  }
  return planRetainedRefMigration(candidates, runs)
}

export function applyRetainedRefMigration(
  plan: FilesystemIdentityPlan<RetainedRefMigrationPayload>,
): number {
  let changed = 0
  for (const move of plan.mapped) {
    const destinationAction = move.payload.destinationTip
      ? `verify ${move.destination} ${move.payload.destinationTip}`
      : `create ${move.destination} ${move.payload.tip}`
    const transaction = [
      'start',
      destinationAction,
      `delete ${move.payload.sourceRef} ${move.payload.tip}`,
      'prepare',
      'commit',
      '',
    ].join('\n')
    const updated = git(move.payload.projectPath, ['update-ref', '--stdin'], transaction)
    if (!updated.ok) {
      throw new Error(`${move.source}: retained ref transaction failed: ${updated.reason}`)
    }
    changed++
  }
  return changed
}

function databasesFromNames(
  project: string,
  engine: 'postgres' | 'mysql',
  names: string[],
  owners: ReadonlyMap<string, string>,
): WorktreeDatabase[] {
  return names.flatMap((name) => {
    const runId = owners.get(`${project}\0${engine}\0${name}`)
    return runId === undefined ? [] : [{ engine, name, runId, project }]
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
  const owners = new Map(
    (
      db()
        .query(
          `SELECT p.name project,rc.root_run_record_id,rc.allocation_key
           FROM resource_claim rc JOIN project p ON p.record_id=rc.project_record_id
           WHERE rc.kind='database' AND rc.state IN ('claimed','retained')`,
        )
        .all() as { project: string; root_run_record_id: string; allocation_key: string }[]
    ).map((row) => {
      const separator = row.allocation_key.indexOf(':')
      const engine = row.allocation_key.slice(0, separator)
      const name = row.allocation_key.slice(separator + 1)
      return [`${row.project}\0${engine}\0${name}`, row.root_run_record_id] as const
    }),
  )
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
      databases.push(...databasesFromNames(project.name, 'postgres', listed.names, owners))
    } else {
      const mysql = provider.mysql ?? 'mysql'
      const listed = listCommand([mysql, '-N', '-e', 'SHOW DATABASES'], project.path)
      if (!listed.ascertainable) return listed
      databases.push(...databasesFromNames(project.name, 'mysql', listed.names, owners))
    }
  }
  return { ascertainable: true, databases }
}

function git(
  cwd: string,
  args: string[],
  stdin?: string,
): { ok: true; out: string } | { ok: false; reason: string; exitCode: number | null } {
  let p: ReturnType<typeof Bun.spawnSync>
  try {
    p = Bun.spawnSync(['git', ...args], {
      cwd,
      env: targetGitEnvironment(cwd),
      stdin: stdin === undefined ? undefined : Buffer.from(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: RESOURCE_INVENTORY_TIMEOUT_MS,
    })
  } catch (error) {
    return {
      ok: false,
      reason: `git inventory unavailable: ${(error as Error).message}`,
      exitCode: null,
    }
  }
  if (p.exitedDueToTimeout) {
    return {
      ok: false,
      reason: `git inventory unavailable: timed out after ${RESOURCE_INVENTORY_TIMEOUT_MS}ms`,
      exitCode: null,
    }
  }
  if (p.exitCode !== 0) {
    const detail = p.stderr?.toString().trim() || `exit ${p.exitCode}`
    return { ok: false, reason: `git inventory unavailable: ${detail}`, exitCode: p.exitCode }
  }
  return { ok: true, out: (p.stdout?.toString() ?? '').trim() }
}

/** Inventory `refs/orch/retained/<run>` pins left after close-out. Never deletes them. */
function retainedRefsForProject(project: Project): GitResourceInventory<RetainedRef> {
  if (!existsSync(project.path)) return { ascertainable: true, items: [] }
  const listed = git(project.path, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/orch/retained',
  ])
  if (!listed.ok) return { ascertainable: false, reason: `${project.name}: ${listed.reason}` }
  const items = (listed.out ? listed.out.split('\n') : []).flatMap((line) => {
    const [ref, sha] = line.split(' ')
    const runRecordId = ref ? parseRetainedRef(ref) : null
    if (!ref || !sha || runRecordId === null) return []
    const runId = db()
      .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
      .get(runRecordId)?.record_id
    return runId === undefined ? [] : [{ ref, sha, runId, project: project.name }]
  })
  return { ascertainable: true, items }
}

export function retainedRefInventory(): GitResourceInventory<RetainedRef> {
  const items: RetainedRef[] = []
  for (const project of projects().filter(isProjectRepository)) {
    const inventory = retainedRefsForProject(project)
    if (!inventory.ascertainable) return inventory
    items.push(...inventory.items)
  }
  return { ascertainable: true, items }
}

/** Inventory `.git/orch-guards/<run>` directories. Never removes them. */
function refGuardsForProject(project: Project): GitResourceInventory<RefGuard> {
  if (!existsSync(project.path)) return { ascertainable: true, items: [] }
  const common = git(project.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!common.ok) return { ascertainable: false, reason: `${project.name}: ${common.reason}` }
  let root: string
  try {
    root = realpathSync(join(common.out, 'orch-guards'))
  } catch {
    return { ascertainable: true, items: [] }
  }
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch (error) {
    return {
      ascertainable: false,
      reason: `${project.name} ref-guard inventory unavailable: ${(error as Error).message}`,
    }
  }
  const items = entries.flatMap((name) => {
    const runRecordId = parseRefGuardRunId(name)
    if (runRecordId === null) return []
    const runId = db()
      .query<{ record_id: string }, [string]>('SELECT record_id FROM run WHERE record_id=?')
      .get(runRecordId)?.record_id
    const path = join(root, name)
    try {
      return runId !== undefined && statSync(path).isDirectory()
        ? [{ path, runId, project: project.name }]
        : []
    } catch {
      return []
    }
  })
  return { ascertainable: true, items }
}

export function refGuardInventory(): GitResourceInventory<RefGuard> {
  const items: RefGuard[] = []
  for (const project of projects().filter(isProjectRepository)) {
    const inventory = refGuardsForProject(project)
    if (!inventory.ascertainable) return inventory
    items.push(...inventory.items)
  }
  return { ascertainable: true, items }
}
