import type { Database } from 'bun:sqlite'
import { db } from './db.ts'
import { FAILURE_KINDS, type FailureKind } from './failure.ts'

export const HEALTH_DEFAULT_DAYS = 14
export const HEALTH_CLASSES = [...FAILURE_KINDS, 'stale', 'stopped'] as const
export type HealthClass = FailureKind | 'stale' | 'stopped'

export type HealthCluster = { text: string; count: number; exampleRunId: number }
export type HealthClassRow = {
  kind: HealthClass
  count: number
  totalTimeMs: number
  meanTimeMs: number
  firstSeen: string | null
  lastSeen: string | null
  clusters: HealthCluster[]
  sparkline: { day: string; count: number }[]
}
export type HealthVerdictRow = { kind: string; verdicts: number; falseVerdicts: number; rate: number }
export type HealthReport = {
  header: string
  days: number
  from: string
  classes: HealthClassRow[]
  falseVerdicts: HealthVerdictRow[]
  landingRefusals: number
}

/** Remove volatile values while retaining the wording that identifies one failure shape. */
export function clusterErrorText(value: string | null | undefined): string {
  if (!value?.trim()) return ''
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(?:file:\/\/)?(?:~\/|\/?(?:Users|private|tmp|var|opt|home)\/)[^\s'"`,;)]+/gi, '<path>')
    .replace(/\b[0-9a-f]{7,64}\b/gi, '<id>')
    .replace(/\b(?:run|session|branch|task|request|call|pid|id)[- _:#=]*[a-z]*[-_]?\d+[a-z0-9_-]*\b/gi, '<id>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

type RunRow = {
  id: number; started_at: string; latency_ms: number | null
  failure_kind: FailureKind | null; status: string; error: string | null
}

const classOf = (row: RunRow): HealthClass | null =>
  row.status === 'stale' || row.status === 'stopped'
    ? row.status
    : row.failure_kind && FAILURE_KINDS.includes(row.failure_kind) ? row.failure_kind : null

export function harnessHealth(days = HEALTH_DEFAULT_DAYS, database: Database = db(), now = new Date()): HealthReport {
  if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a positive integer')
  const from = new Date(now.getTime() - days * 86_400_000).toISOString()
  const runs = database.query(
    `SELECT id,started_at,latency_ms,failure_kind,status,error FROM run
      WHERE datetime(started_at) >= datetime(?) ORDER BY started_at,id`,
  ).all(from) as RunRow[]
  const dayKeys = Array.from({ length: days }, (_, offset) =>
    new Date(now.getTime() - (days - 1 - offset) * 86_400_000).toISOString().slice(0, 10))

  const classes = HEALTH_CLASSES.map((kind): HealthClassRow => {
    const matching = runs.filter((row) => classOf(row) === kind)
    const totalTimeMs = matching.reduce((sum, row) => sum + Math.max(0, row.latency_ms ?? 0), 0)
    const grouped = new Map<string, { count: number; exampleRunId: number }>()
    for (const row of matching) {
      const text = clusterErrorText(row.error)
      if (!text) continue
      const found = grouped.get(text)
      if (found) found.count++
      else grouped.set(text, { count: 1, exampleRunId: row.id })
    }
    const clusters = [...grouped].map(([text, value]) => ({ text, ...value }))
      .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)).slice(0, 3)
    return {
      kind, count: matching.length, totalTimeMs,
      meanTimeMs: matching.length ? Math.round(totalTimeMs / matching.length) : 0,
      firstSeen: matching[0]?.started_at ?? null,
      lastSeen: matching.at(-1)?.started_at ?? null,
      clusters,
      sparkline: dayKeys.map((day) => ({
        day, count: matching.filter((row) => row.started_at.slice(0, 10) === day).length,
      })),
    }
  })

  const cleared = database.query(
    `SELECT DISTINCT run_id FROM run_mutation_audit
      WHERE action='reclassify' AND datetime(at) >= datetime(?)
        AND json_extract(reason,'$.cleared')=1`,
  ).all(from) as { run_id: number }[]
  const voided = database.query(
    `SELECT DISTINCT a.run_id, r.failure_kind kind FROM run_mutation_audit a
      JOIN run r ON r.id=a.run_id
      WHERE a.action='void' AND datetime(a.at) >= datetime(?) AND r.failure_kind IS NOT NULL`,
  ).all(from) as { run_id: number; kind: string }[]
  const falseByKind = new Map<string, Set<number>>()
  const addFalse = (kind: string, id: number) => {
    const ids = falseByKind.get(kind) ?? new Set<number>(); ids.add(id); falseByKind.set(kind, ids)
  }
  for (const row of cleared) addFalse('escaped', row.run_id)
  for (const row of voided) addFalse(row.kind, row.run_id)
  const falseVerdicts = [...FAILURE_KINDS].map((kind): HealthVerdictRow => {
    const falseIds = falseByKind.get(kind) ?? new Set<number>()
    const currentIds = new Set(runs.filter((row) => classOf(row) === kind).map((row) => row.id))
    for (const id of falseIds) currentIds.add(id)
    return {
      kind, verdicts: currentIds.size, falseVerdicts: falseIds.size,
      rate: currentIds.size ? falseIds.size / currentIds.size : 0,
    }
  })
  const landingRefusals = (database.query(
    `SELECT COUNT(*) n FROM landing WHERE status='refused' AND datetime(started_at) >= datetime(?)`,
  ).get(from) as { n: number }).n
  return {
    header: 'Harness health only — never routing or scoring evidence. Confinement clears are reclassify audit rows with cleared:true; landing refusals are reported separately.',
    days, from, classes, falseVerdicts, landingRefusals,
  }
}
