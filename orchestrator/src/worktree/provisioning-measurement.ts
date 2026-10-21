// concern: provisioning measurement
/** Cheap, bounded measurements for one worker-tree creation. */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { db } from '../database/db.ts'
import type { HostLoadSample } from '../host-load-sample.ts'
import { STORAGE_WALK_ENTRY_LIMIT } from '../storage-walk.ts'
import type { CloneProvisionMeasurement, ProvisionEntry } from './worktree-provision.ts'

const PROVISIONING_ENTRY_LIMIT = STORAGE_WALK_ENTRY_LIMIT
export type ProvisioningPhase = { phase: string; name: string; durationMs: number }

function workspacePatterns(tree: string): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')) as {
      workspaces?: string[] | { packages?: string[] }
    }
    const patterns = Array.isArray(manifest.workspaces)
      ? manifest.workspaces
      : (manifest.workspaces?.packages ?? [])
    return patterns.filter(
      (pattern) => !pattern.startsWith('/') && !pattern.split('/').includes('..'),
    )
  } catch {
    return []
  }
}

/** Dependency roots are declared provisions plus conventional roots in the tree and workspaces. */
function dependencyEntryRoots(tree: string, provisions: readonly ProvisionEntry[]): string[] {
  const workspaceDirs = workspacePatterns(tree).flatMap((pattern) => {
    try {
      return [
        ...new Bun.Glob(`${pattern.replace(/\/$/, '')}/package.json`).scanSync({ cwd: tree }),
      ].map((manifest) => dirname(manifest))
    } catch {
      return []
    }
  })
  const candidates = [
    ...provisions.map((entry) => entry.path),
    'node_modules',
    'vendor',
    ...workspaceDirs.flatMap((path) => [join(path, 'node_modules'), join(path, 'vendor')]),
  ]
  return [...new Set(candidates)].filter((path) => existsSync(join(tree, path)))
}

function countDependencyEntries(
  tree: string,
  provisions: readonly ProvisionEntry[],
  limit = PROVISIONING_ENTRY_LIMIT,
): { count: number; limited: boolean; roots: string[] } {
  const roots = dependencyEntryRoots(tree, provisions)
  const pending = roots.map((path) => join(tree, path))
  let count = 0
  while (pending.length && count < limit) {
    const path = pending.pop()!
    try {
      const stat = lstatSync(path)
      count++
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        for (const name of readdirSync(path)) pending.push(join(path, name))
      }
    } catch {
      // A dependency can disappear with failed-tree cleanup; retain the count established so far.
    }
  }
  return {
    count,
    limited: pending.length > 0,
    roots: roots.map((path) => relative(tree, join(tree, path))),
  }
}

export function appendProvisioningPhases(
  runId: string,
  phases: readonly ProvisioningPhase[],
): void {
  if (!phases.length) return
  const row = db().query('SELECT provisioning_phases FROM run WHERE record_id=?').get(runId) as {
    provisioning_phases: string | null
  } | null
  const prior = row?.provisioning_phases
    ? (JSON.parse(row.provisioning_phases) as ProvisioningPhase[])
    : []
  db()
    .query('UPDATE run SET provisioning_phases=? WHERE record_id=?')
    .run(JSON.stringify([...prior, ...phases]), runId)
}

/** Record which copy-on-write mechanism handled each declared clone entry. */
export function cloneProvisionRecorder(runId: string) {
  return (measurement: CloneProvisionMeasurement): void =>
    appendProvisioningPhases(runId, [
      {
        phase: 'dependency',
        name: `${measurement.path} (${measurement.mechanism})`,
        durationMs: measurement.durationMs,
      },
    ])
}

/** Measure and persist one named provisioning operation even when it fails. */
export function measureProvisioningPhase<T>(
  runId: string,
  phase: string,
  name: string,
  operation: () => T,
): T {
  const started = performance.now()
  try {
    return operation()
  } finally {
    appendProvisioningPhases(runId, [{ phase, name, durationMs: performance.now() - started }])
  }
}

export function finishProvisioningMeasurement(input: {
  runId: string
  kind: 'writer' | 'read-only'
  outcome: 'ok' | 'failed'
  started: number
  hostLoad: HostLoadSample
  tree: string | null
  provisions: readonly ProvisionEntry[]
}): void {
  const durationMs = Math.round(Math.max(0, performance.now() - input.started))
  const entries =
    input.tree && existsSync(input.tree)
      ? countDependencyEntries(input.tree, input.provisions)
      : null
  db()
    .query(
      `UPDATE run SET provisioning_kind=?,provisioning_ms=?,provisioning_entries=?,
      provisioning_entries_limited=?,provisioning_host_load=?,provisioning_outcome=?,
      provisioning_entry_roots=? WHERE record_id=?`,
    )
    .run(
      input.kind,
      durationMs,
      entries?.count ?? null,
      entries ? (entries.limited ? 1 : 0) : null,
      JSON.stringify(input.hostLoad),
      input.outcome,
      entries ? JSON.stringify(entries.roots) : null,
      input.runId,
    )
}
