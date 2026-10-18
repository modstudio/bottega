// concern: storage-report
/** Bounded filesystem adapter used by machine storage and disk pressure monitoring. */

import { lstatSync, readdirSync, statfsSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  resolveHubDatabase,
  resolveOrchestratorDatabase,
  resolveRunsDirectory,
  resolveStateRoot,
} from '../../../shared/state-directory.ts'
import { db } from '../database/db.ts'
import { isProjectRepository, projects } from '../project/projects.ts'
import type { MonitorCondition } from './monitor-types.ts'
import {
  deduplicateHardLinkedBytes,
  diskPressureCondition,
  type LargestRuns,
  largestRuns,
  STORAGE_WALK_ENTRY_LIMIT,
  type StorageKindSummary,
  type StorageMeasurement,
  type StorageVolume,
  storageMeasurement,
} from './storage-conditions.ts'

type WalkObservation = {
  bytes: number
  hardLinkKey: string | null
  kind: RunStorageKind
  runId: number | null
}
type RunStorageKind = 'artifacts' | 'scratch' | 'sandboxes' | 'prompts' | 'replies' | 'other'

export type StorageReport = {
  measuredAt: string
  walkDurationMs: number
  entryLimit: number
  runs: {
    path: string
    kinds: Record<RunStorageKind, StorageMeasurement>
    largestRuns: { artifacts: LargestRuns; scratch: LargestRuns }
  }
  worktrees: { project: string; path: string; measurement: StorageMeasurement }[]
  stores: {
    kind: 'orch.db' | 'orch.db-wal' | 'hub.db' | 'hub.db-wal'
    path: string
    measurement: StorageMeasurement
  }[]
  volume: StorageVolume
}

type WalkResult = {
  observations: WalkObservation[]
  entries: number
  stoppedAtLimit: boolean
  errors: string[]
  unreadable: string | null
}

async function walk(
  root: string,
  classify: (relativePath: string) => { kind: RunStorageKind; runId: number | null },
  entryLimit = STORAGE_WALK_ENTRY_LIMIT,
): Promise<WalkResult> {
  const start = startWalk(root, classify)
  if (start.completed) return start.completed
  const pending = start.pending
  const observations: WalkObservation[] = []
  const errors: string[] = []
  let cursor = 0
  let entries = 0
  let attempted = 0
  const concurrency = 256
  while (cursor < pending.length && attempted < entryLimit) {
    const batch = pending.slice(
      cursor,
      Math.min(pending.length, cursor + concurrency, cursor + entryLimit - attempted),
    )
    cursor += batch.length
    attempted += batch.length
    const inspected = await Promise.all(batch.map((path) => inspectEntry(root, path, classify)))
    for (const item of inspected) {
      if (item.error) errors.push(item.error)
      if (!item.observation) continue
      entries++
      observations.push(item.observation)
      pending.push(...item.children)
    }
  }
  return {
    observations: deduplicateHardLinkedBytes(observations),
    entries,
    stoppedAtLimit: attempted >= entryLimit && cursor < pending.length,
    errors,
    unreadable: null,
  }
}

function startWalk(
  root: string,
  classify: (relativePath: string) => { kind: RunStorageKind; runId: number | null },
): { completed: WalkResult | null; pending: string[] } {
  try {
    const rootStat = lstatSync(root)
    if (!rootStat.isDirectory()) {
      return {
        completed: {
          observations: [
            {
              bytes: typeof rootStat.blocks === 'number' ? rootStat.blocks * 512 : rootStat.size,
              hardLinkKey:
                rootStat.isFile() && rootStat.nlink > 1 ? `${rootStat.dev}:${rootStat.ino}` : null,
              ...classify(''),
            },
          ],
          entries: 1,
          stoppedAtLimit: false,
          errors: [],
          unreadable: null,
        },
        pending: [],
      }
    }
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException
    if (error.code === 'ENOENT')
      return {
        completed: {
          observations: [],
          entries: 0,
          stoppedAtLimit: false,
          errors: [],
          unreadable: null,
        },
        pending: [],
      }
    return {
      completed: {
        observations: [],
        entries: 0,
        stoppedAtLimit: false,
        errors: [],
        unreadable: String(error.message ?? cause),
      },
      pending: [],
    }
  }
  try {
    return {
      completed: null,
      pending: readdirSync(root).map((name) => join(root, name)),
    }
  } catch (cause) {
    return {
      completed: {
        observations: [],
        entries: 0,
        stoppedAtLimit: false,
        errors: [],
        unreadable: String((cause as Error).message ?? cause),
      },
      pending: [],
    }
  }
}

async function inspectEntry(
  root: string,
  path: string,
  classify: (relativePath: string) => { kind: RunStorageKind; runId: number | null },
): Promise<{ observation: WalkObservation | null; children: string[]; error: string | null }> {
  try {
    const stat = await lstat(path)
    const observation = {
      bytes: typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size,
      hardLinkKey: stat.isFile() && stat.nlink > 1 ? `${stat.dev}:${stat.ino}` : null,
      ...classify(relative(root, path)),
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { observation, children: [], error: null }
    }
    try {
      return {
        observation,
        children: readdirSync(path).map((name) => join(path, name)),
        error: null,
      }
    } catch (cause) {
      return {
        observation,
        children: [],
        error: `${path}: ${String((cause as Error).message ?? cause)}`,
      }
    }
  } catch (cause) {
    return {
      observation: null,
      children: [],
      error: `${path}: ${String((cause as Error).message ?? cause)}`,
    }
  }
}

async function measurePath(path: string): Promise<StorageMeasurement> {
  const result = await walk(path, () => ({ kind: 'other', runId: null }))
  return storageMeasurement({
    bytes: result.observations.reduce((total, entry) => total + entry.bytes, 0),
    entries: result.entries,
    stoppedAtLimit: result.stoppedAtLimit,
    errors: result.errors,
    unreadable: result.unreadable,
  })
}

export type StoragePathMeasurement = {
  bytes: number
  entries: number
  errors: string[]
  stoppedAtLimit: boolean
}

/** Measure selected paths with the storage report's allocated-byte and hard-link rules. */
export function measureStoragePaths(
  paths: readonly string[],
  entryLimit = STORAGE_WALK_ENTRY_LIMIT,
): StoragePathMeasurement {
  const pending = [...new Set(paths.map((path) => resolve(path)))]
  const observations: WalkObservation[] = []
  const errors: string[] = []
  let entries = 0
  let attempted = 0
  while (pending.length > 0 && attempted < entryLimit) {
    const path = pending.shift()!
    attempted++
    try {
      const stat = lstatSync(path)
      entries++
      observations.push({
        bytes: typeof stat.blocks === 'number' ? stat.blocks * 512 : stat.size,
        hardLinkKey: stat.isFile() && stat.nlink > 1 ? `${stat.dev}:${stat.ino}` : null,
        kind: 'other',
        runId: null,
      })
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        pending.push(...readdirSync(path).map((name) => join(path, name)))
      }
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException
      if (error.code !== 'ENOENT') errors.push(`${path}: ${String(error.message ?? cause)}`)
    }
  }
  const deduplicated = deduplicateHardLinkedBytes(observations)
  return {
    bytes: deduplicated.reduce((total, entry) => total + entry.bytes, 0),
    entries,
    errors,
    stoppedAtLimit: pending.length > 0,
  }
}

function runClassifier(
  runsRoot: string,
  promptPaths: ReadonlySet<string>,
  replyPaths: ReadonlySet<string>,
): (relativePath: string) => { kind: RunStorageKind; runId: number | null } {
  return (relativePath) => {
    const absolute = resolve(runsRoot, relativePath)
    const parts = relativePath.split('/')
    const numericId = parts[0] && /^\d+$/.test(parts[0]) ? Number(parts[0]) : null
    const sandbox = parts[0]?.match(/^sandbox-(\d+)$/)
    if (numericId !== null && parts[1] === 'artifacts')
      return { kind: 'artifacts', runId: numericId }
    if (numericId !== null && parts[1] === 'scratch') return { kind: 'scratch', runId: numericId }
    if (sandbox) return { kind: 'sandboxes', runId: Number(sandbox[1]) }
    if (promptPaths.has(absolute)) return { kind: 'prompts', runId: numericId }
    if (replyPaths.has(absolute) || (numericId !== null && parts[1] === 'reply.txt')) {
      return { kind: 'replies', runId: numericId }
    }
    return { kind: 'other', runId: numericId }
  }
}

export type StorageRunFact = {
  id: number
  status: string
  started_at: string
  prompt_path: string | null
  output_path: string | null
}

/** Exercise the real bounded run-store walk with caller-owned paths and facts. */
export async function measureRunStorage(
  runsPath: string,
  rows: readonly StorageRunFact[],
  clock: number,
  entryLimit = STORAGE_WALK_ENTRY_LIMIT,
): Promise<StorageReport['runs']> {
  const recordedPrompts = rows.flatMap((row) => (row.prompt_path ? [resolve(row.prompt_path)] : []))
  const prompts = new Set([
    ...recordedPrompts,
    ...recordedPrompts.map((path) => path.replace(/\.prompt\.txt$/, '.bound.txt')),
  ])
  const replies = new Set(
    rows.flatMap((row) => (row.output_path ? [resolve(row.output_path)] : [])),
  )
  const runWalk = await walk(runsPath, runClassifier(runsPath, prompts, replies), entryLimit)
  const partial = Boolean(runWalk.stoppedAtLimit || runWalk.errors.length || runWalk.unreadable)
  const kinds = Object.fromEntries(
    (['artifacts', 'scratch', 'sandboxes', 'prompts', 'replies', 'other'] as const).map((kind) => {
      const observed = runWalk.observations.filter((entry) => entry.kind === kind)
      return [
        kind,
        storageMeasurement({
          bytes: observed.reduce((total, entry) => total + entry.bytes, 0),
          entries: observed.length,
          stoppedAtLimit: runWalk.stoppedAtLimit,
          errors: runWalk.errors,
          unreadable: runWalk.unreadable,
          entryLimit,
        }),
      ]
    }),
  ) as Record<RunStorageKind, StorageMeasurement>
  const facts = new Map(
    rows.map((row) => [row.id, { startedAt: row.started_at, status: row.status }]),
  )
  const sizesFor = (kind: 'artifacts' | 'scratch') => {
    const sizes = new Map<number, number>()
    for (const entry of runWalk.observations) {
      if (entry.kind !== kind || entry.runId === null) continue
      sizes.set(entry.runId, (sizes.get(entry.runId) ?? 0) + entry.bytes)
    }
    return largestRuns(sizes, facts, clock, partial)
  }
  return {
    path: runsPath,
    kinds,
    largestRuns: { artifacts: sizesFor('artifacts'), scratch: sizesFor('scratch') },
  }
}

function measureVolume(environment: NodeJS.ProcessEnv = process.env): StorageVolume {
  const path = environment.ORCH_DB
    ? dirname(resolveOrchestratorDatabase(environment))
    : resolveStateRoot(environment)
  try {
    const stat = statfsSync(path)
    return {
      path,
      freeBytes: Number(stat.bavail) * Number(stat.bsize),
      totalBytes: Number(stat.blocks) * Number(stat.bsize),
      error: null,
    }
  } catch (cause) {
    return {
      path,
      freeBytes: null,
      totalBytes: null,
      error: String((cause as Error).message ?? cause),
    }
  }
}

export async function storageReport(clock = Date.now()): Promise<StorageReport> {
  const started = performance.now()
  const database = db()
  const runsPath = resolveRunsDirectory(process.env)
  const rows = database
    .query('SELECT id,status,started_at,prompt_path,output_path FROM run')
    .all() as {
    id: number
    status: string
    started_at: string
    prompt_path: string | null
    output_path: string | null
  }[]
  const runs = await measureRunStorage(runsPath, rows, clock)
  const orch = resolveOrchestratorDatabase(process.env)
  const hub = resolveHubDatabase(process.env)
  const worktrees = await Promise.all(
    projects()
      .filter(isProjectRepository)
      .map(async (project) => {
        const path = join(project.path, '.claude', 'worktrees')
        return { project: project.name, path, measurement: await measurePath(path) }
      }),
  )
  const storePaths = [
    { kind: 'orch.db' as const, path: orch },
    { kind: 'orch.db-wal' as const, path: `${orch}-wal` },
    { kind: 'hub.db' as const, path: hub },
    { kind: 'hub.db-wal' as const, path: `${hub}-wal` },
  ]
  const stores = await Promise.all(
    storePaths.map(async (store) => ({ ...store, measurement: await measurePath(store.path) })),
  )
  const report: StorageReport = {
    measuredAt: new Date(clock).toISOString(),
    walkDurationMs: 0,
    entryLimit: STORAGE_WALK_ENTRY_LIMIT,
    runs,
    worktrees,
    stores,
    volume: measureVolume(),
  }
  report.walkDurationMs = Math.round(performance.now() - started)
  return report
}

function storageKindSummaries(report: StorageReport): StorageKindSummary[] {
  return [
    ...Object.entries(report.runs.kinds).map(([kind, measurement]) => ({
      label: `runs ${kind}`,
      measurement,
    })),
    ...report.worktrees.map(({ project, measurement }) => ({
      label: `${project} worktrees`,
      measurement,
    })),
    ...report.stores.map(({ kind, measurement }) => ({ label: kind, measurement })),
  ]
}

export async function diskPressureObservation(clock = Date.now()): Promise<{
  conditions: MonitorCondition[]
  errors: string[]
}> {
  const volume = measureVolume()
  const preliminary = diskPressureCondition(volume, [], clock)
  if (preliminary.error) return { conditions: [], errors: [`disk space: ${preliminary.error}`] }
  if (!preliminary.condition) return { conditions: [], errors: [] }
  const report = await storageReport(clock)
  const decision = diskPressureCondition(volume, storageKindSummaries(report), clock)
  const condition = decision.condition
  return {
    conditions: condition
      ? [
          {
            kind: condition.kind,
            subject: condition.subject,
            since: condition.since,
            ageMs: condition.ageMs,
            detail: condition.detail,
            action: `run ${PLATFORM_SLUG} ${condition.remedy.reportCommand}, then use ${PLATFORM_SLUG} ${condition.remedy.reclaimCommand} for the classified resources that apply`,
          } satisfies MonitorCondition,
        ]
      : [],
    errors: [],
  }
}

function formatMeasurement(measurement: StorageMeasurement): string {
  if (measurement.state === 'unreadable') return `unreadable: ${measurement.detail}`
  const prefix = measurement.state === 'partial' ? 'at least ' : ''
  return `${prefix}${measurement.bytes} bytes, ${prefix}${measurement.entries} entries${measurement.detail ? ` (${measurement.detail})` : ''}`
}

export function formatStorageReport(report: StorageReport): string {
  const lines = [
    `storage measured in ${report.walkDurationMs}ms (walk cap ${report.entryLimit} entries)`,
    `volume ${report.volume.path}: ${report.volume.freeBytes ?? 'unreadable'} free bytes of ${report.volume.totalBytes ?? 'unreadable'}`,
    `runs ${report.runs.path}:`,
  ]
  for (const [kind, measurement] of Object.entries(report.runs.kinds))
    lines.push(`  ${kind}: ${formatMeasurement(measurement)}`)
  for (const kind of ['artifacts', 'scratch'] as const) {
    const largest = report.runs.largestRuns[kind]
    lines.push(`  largest ${kind}${largest.state === 'partial' ? ' (partial ranking)' : ''}:`)
    for (const run of largest.runs)
      lines.push(
        `    run ${run.runId}: ${run.state === 'partial' ? 'at least ' : ''}${run.bytes} bytes, age ${run.ageMs ?? 'unknown'}ms, ${run.status}`,
      )
  }
  lines.push('worktrees:')
  for (const item of report.worktrees)
    lines.push(`  ${item.project} ${item.path}: ${formatMeasurement(item.measurement)}`)
  lines.push('stores:')
  for (const store of report.stores)
    lines.push(`  ${store.kind} ${store.path}: ${formatMeasurement(store.measurement)}`)
  return lines.join('\n')
}
