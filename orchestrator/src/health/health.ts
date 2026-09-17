import type { Database } from 'bun:sqlite'
import {
  AttributionKindSchema,
  emptyAttribution,
  type HarnessHealth,
  HarnessHealthSchema,
  HostLoadSchema,
} from '../../../shared/orch-contract.ts'
import { attributionCounts, parseConfinement } from '../confinement/confinement.ts'
import { summarizeContention } from '../database/contention.ts'
import { db } from '../database/db.ts'
import { clusterErrorText, FAILURE_KINDS, type FailureKind } from '../failure/failure.ts'
import { parseIdleReclaimedMs } from '../idle-kill.ts'
import { parseMcpProbe } from '../mcp/mcp-probe.ts'

const HEALTH_DEFAULT_DAYS = 14
const HEALTH_CLASSES = [...FAILURE_KINDS, 'stale'] as const
type HealthClass = FailureKind | 'stale' | 'stopped'

type HealthClassRow = HarnessHealth['classes'][number] & { kind: HealthClass }
type HealthVerdictRow = HarnessHealth['falseVerdicts'][number]

export function landingsWithPostStepError(database: Database = db()): {
  project: string
  branch: string
  error: string
}[] {
  return database
    .query(
      `SELECT project, branch, error FROM landing
      WHERE status='install_failed' AND error IS NOT NULL ORDER BY id`,
    )
    .all() as { project: string; branch: string; error: string }[]
}

type RunRow = {
  id: number
  started_at: string
  latency_ms: number | null
  failure_kind: FailureKind | null
  status: string
  error: string | null
  work_preserved: number
}

const classOf = (row: RunRow): HealthClass | null =>
  row.status === 'stale' || row.status === 'stopped'
    ? row.status
    : row.failure_kind && FAILURE_KINDS.includes(row.failure_kind)
      ? row.failure_kind
      : null

export function harnessHealth(
  days = HEALTH_DEFAULT_DAYS,
  database: Database = db(),
  now = new Date(),
): HarnessHealth {
  if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a positive integer')
  const firstDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)),
  )
  const from = firstDay.toISOString()
  const runs = database
    .query(
      `SELECT id,started_at,latency_ms,failure_kind,status,error,work_preserved FROM run
      WHERE datetime(started_at) >= datetime(?) ORDER BY started_at,id`,
    )
    .all(from) as RunRow[]
  const dayKeys = Array.from({ length: days }, (_, offset) =>
    new Date(firstDay.getTime() + offset * 86_400_000).toISOString().slice(0, 10),
  )

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
    const clusters = [...grouped]
      .map(([text, value]) => ({ text, ...value }))
      .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
      .slice(0, 3)
    const reclaimedMs =
      kind === 'idle'
        ? matching.reduce((sum, row) => sum + (parseIdleReclaimedMs(row.error) ?? 0), 0)
        : undefined
    return {
      kind,
      count: matching.length,
      totalTimeMs,
      workPreserved: matching.filter((row) => row.work_preserved === 1).length,
      ...(reclaimedMs !== undefined ? { reclaimedMs } : {}),
      meanTimeMs: matching.length ? Math.round(totalTimeMs / matching.length) : 0,
      firstSeen: matching[0]?.started_at ?? null,
      lastSeen: matching.at(-1)?.started_at ?? null,
      clusters,
      sparkline: dayKeys.map((day) => ({
        day,
        count: matching.filter((row) => row.started_at.slice(0, 10) === day).length,
      })),
    }
  })

  const cleared = database
    .query(
      `SELECT DISTINCT run_id FROM run_mutation_audit
      WHERE action='reclassify' AND json_extract(reason,'$.cleared')=1`,
    )
    .all() as { run_id: number }[]
  const voided = database
    .query(
      `SELECT DISTINCT a.run_id, r.failure_kind kind FROM run_mutation_audit a
      JOIN run r ON r.id=a.run_id
      WHERE a.action='void' AND r.failure_kind IS NOT NULL`,
    )
    .all() as { run_id: number; kind: string }[]
  const cohortIds = new Set(runs.map((row) => row.id))
  const falseByKind = new Map<string, Set<number>>()
  const addFalse = (kind: string, id: number) => {
    const ids = falseByKind.get(kind) ?? new Set<number>()
    ids.add(id)
    falseByKind.set(kind, ids)
  }
  for (const row of cleared) if (cohortIds.has(row.run_id)) addFalse('escaped', row.run_id)
  for (const row of voided) if (cohortIds.has(row.run_id)) addFalse(row.kind, row.run_id)
  const falseVerdicts = [...FAILURE_KINDS].map((kind): HealthVerdictRow => {
    const falseIds = falseByKind.get(kind) ?? new Set<number>()
    const currentIds = new Set(runs.filter((row) => classOf(row) === kind).map((row) => row.id))
    for (const id of falseIds) currentIds.add(id)
    return {
      kind,
      verdicts: currentIds.size,
      falseVerdicts: falseIds.size,
      rate: currentIds.size ? falseIds.size / currentIds.size : 0,
    }
  })
  const landingRefusals = (
    database
      .query(
        `SELECT COUNT(*) n FROM landing WHERE status='refused' AND datetime(started_at) >= datetime(?)`,
      )
      .get(from) as { n: number }
  ).n
  const mcpProbeColumn = database
    .query("SELECT 1 AS n FROM pragma_table_info('run') WHERE name='mcp_probe'")
    .get() as { n: number } | null
  let mcpProbeFailures = 0
  let mcpUnprobed = 0
  const mcpUnverified = new Map<string, number>()
  if (mcpProbeColumn) {
    const mcpRows = database
      .query(
        `SELECT agent, mcp_probe FROM run
        WHERE mcp IN (1, 2) AND datetime(started_at) >= datetime(?)`,
      )
      .all(from) as { agent: string; mcp_probe: string | null }[]
    for (const row of mcpRows) {
      const probe = parseMcpProbe(row.mcp_probe)
      if (!probe) mcpUnprobed++
      else if (!probe.ok) mcpProbeFailures++
      if (!probe || !probe.ok || probe.tool === 'tools/list') {
        mcpUnverified.set(row.agent, (mcpUnverified.get(row.agent) ?? 0) + 1)
      }
    }
  }
  const flakeTable = database
    .query("SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name='test_flake'")
    .get() as { n: number } | null
  const flakeRows = flakeTable
    ? (database
        .query(
          `SELECT f.test, f.file, c.count, f.load_at_failure, f.signal
       FROM test_flake f
       JOIN (
         SELECT test, file, COUNT(*) AS count, MAX(at) AS last_at
           FROM test_flake
          WHERE datetime(at) >= datetime(?)
          GROUP BY test, file
       ) c ON c.test=f.test AND c.file=f.file AND c.last_at=f.at
      ORDER BY c.count DESC, f.test, f.file`,
        )
        .all(from) as {
        test: string
        file: string
        count: number
        load_at_failure: string
        signal: string | null
      }[])
    : []
  const flakes = flakeRows.flatMap((row) => {
    try {
      const load = HostLoadSchema.safeParse(JSON.parse(row.load_at_failure))
      if (!load.success) return []
      return [
        {
          test: row.test,
          file: row.file,
          count: row.count,
          loadAtFailure: load.data,
          signal: row.signal,
        },
      ]
    } catch {
      return []
    }
  })
  const confinementTable = database
    .query("SELECT 1 AS n FROM pragma_table_info('run') WHERE name='confinement'")
    .get() as { n: number } | null
  const attribution = confinementTable
    ? attributionCounts(
        (
          database
            .query(
              `SELECT confinement FROM run
        WHERE confinement IS NOT NULL AND datetime(started_at) >= datetime(?)`,
            )
            .all(from) as { confinement: string | null }[]
        ).map((row) => parseConfinement(row.confinement)),
      )
    : emptyAttribution()
  const classesWithAttribution = classes.map((row) =>
    row.kind === 'escaped'
      ? {
          ...row,
          attribution: Object.fromEntries(
            AttributionKindSchema.options.map((kind) => [kind, attribution[kind]]),
          ) as typeof attribution,
        }
      : row,
  )
  const provenanceColumn = database
    .query("SELECT 1 AS n FROM pragma_table_info('run') WHERE name='review_provenance'")
    .get() as { n: number } | null
  const provenance = provenanceColumn
    ? (database
        .query(
          `SELECT agent,
       SUM(CASE WHEN json_array_length(json_extract(review_provenance,'$.substitutes')) > 0 THEN 1 ELSE 0 END) substituted,
       SUM(CASE WHEN provenance_status='silent' THEN 1 ELSE 0 END) silent
       FROM run WHERE review_provenance IS NOT NULL AND datetime(started_at) >= datetime(?)
       GROUP BY agent ORDER BY agent`,
        )
        .all(from) as { agent: string; substituted: number; silent: number }[])
    : []

  return HarnessHealthSchema.parse({
    header:
      'Harness health only — never routing or scoring evidence. Review measurement gaps are harness failures from bb28501 on 2026-09-07; that step is reclassification, not regression. Confinement clears are reclassify audit rows with cleared:true; landing refusals are reported separately. Contention is waits, refusals and invalidations on shared resources — never routing evidence.',
    days,
    from,
    classes: classesWithAttribution,
    falseVerdicts,
    landingRefusals,
    mcpProbeFailures,
    mcpUnprobed,
    mcpUnverifiedByAgent: [...mcpUnverified]
      .map(([agent, count]) => ({ agent, count }))
      .sort((a, b) => b.count - a.count || a.agent.localeCompare(b.agent)),
    provenance,
    flakes,
    contention: summarizeContention(database, from),
  })
}
