// concern: record-runs
/** Owns tenant-bound record run reads. Must not know local run phases or CLI presentation. */
import { SQL } from 'bun'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'

export type RecordCursor = { at: string; id: string }
type RecordScore = {
  runId?: string
  delivery: string
  quality: string | null
  fidelity: string | null
  scoredAt: string
  note?: string | null
  scoredBy?: string
  updatedAt?: string
}
export type RecordRun = {
  id: string
  spaceId: string
  spaceName: string
  projectName: string | null
  startedAt: string
  finishedAt: string | null
  agent: string
  job: string
  status: string
  latencyMs: number | null
  promptHead: string
  failureKind: string | null
  vendorTokens: number | null
  vendorCostUsd: number | null
  label: string | null
  lens: string | null
  parentRunId: string | null
  turn: number
  evidenceExcluded: string | null
  score: RecordScore | null
}
export type RecordRunDetail = RecordRun & Record<string, unknown> & { reviews: unknown[] }

type RunListInput = TenantPrincipal & {
  url: string
  limit: number
  before: RecordCursor | null
  project?: string
  agent?: string
  job?: string
  status?: string
}

const iso = (value: unknown) => (value == null ? null : new Date(String(value)).toISOString())
const numeric = (value: unknown) => (value == null ? null : Number(value))
const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
const presentation = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      camel(key),
      value instanceof Date
        ? value.toISOString()
        : typeof value === 'bigint'
          ? Number(value)
          : value,
    ]),
  )

function runRow(row: Record<string, unknown>): RecordRun {
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    spaceName: String(row.space_name),
    projectName: row.project_name == null ? null : String(row.project_name),
    startedAt: iso(row.started_at)!,
    finishedAt: iso(row.finished_at),
    agent: String(row.agent),
    job: String(row.job),
    status: String(row.status),
    latencyMs: numeric(row.latency_ms),
    promptHead: String(row.prompt_head),
    failureKind: row.failure_kind == null ? null : String(row.failure_kind),
    vendorTokens: numeric(row.vendor_tokens),
    vendorCostUsd: numeric(row.vendor_cost_usd),
    label: row.label == null ? null : String(row.label),
    lens: row.lens == null ? null : String(row.lens),
    parentRunId: row.parent_run_id == null ? null : String(row.parent_run_id),
    turn: Number(row.turn),
    evidenceExcluded: row.evidence_excluded == null ? null : String(row.evidence_excluded),
    score:
      row.delivery == null
        ? null
        : {
            delivery: String(row.delivery),
            quality: row.quality == null ? null : String(row.quality),
            fidelity: row.fidelity == null ? null : String(row.fidelity),
            scoredAt: iso(row.scored_at)!,
          },
  }
}

async function tenant<T>(input: { url: string } & TenantPrincipal, read: (tx: SQL) => Promise<T>) {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, input)
      return read(tx)
    })
  } finally {
    await client.close()
  }
}

export async function listRecordRuns(input: RunListInput): Promise<RecordRun[]> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT r.id, r.space_id, sp.name AS space_name, p.name AS project_name,
        r.started_at, r.finished_at, r.agent, r.job,
        r.status, r.latency_ms, r.prompt_head, r.failure_kind, r.vendor_tokens,
        r.vendor_cost_usd, r.label, r.lens, r.parent_run_id, r.turn, r.evidence_excluded,
        s.delivery, s.quality, s.fidelity, s.scored_at
      FROM run r JOIN space sp ON sp.id=r.space_id
      LEFT JOIN project p ON p.id=r.project_id LEFT JOIN run_score s ON s.run_id=r.id
      WHERE (${input.before?.at ?? null}::timestamptz IS NULL OR (r.started_at, r.id) < (${input.before?.at ?? null}::timestamptz, ${input.before?.id ?? null}::uuid))
        AND (${input.project ?? null}::text IS NULL OR p.name=${input.project ?? null})
        AND (${input.agent ?? null}::text IS NULL OR r.agent=${input.agent ?? null})
        AND (${input.job ?? null}::text IS NULL OR r.job=${input.job ?? null})
        AND (${input.status ?? null}::text IS NULL OR r.status=${input.status ?? null})
      ORDER BY r.started_at DESC, r.id DESC LIMIT ${input.limit + 1}
    `
    return rows.map(runRow)
  })
}

export async function getRecordRun(input: {
  url: string
  userId: string
  spaceId: string
  spaceIds?: string[]
  id: string
}): Promise<RecordRunDetail | null> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT r.*, sp.name AS space_name, p.name AS project_name,
        s.delivery, s.quality, s.fidelity, s.scored_at,
        s.note, s.scored_by, s.updated_at AS score_updated_at
      FROM run r JOIN space sp ON sp.id=r.space_id
      LEFT JOIN project p ON p.id=r.project_id LEFT JOIN run_score s ON s.run_id=r.id
      WHERE r.id=${input.id}::uuid
    `
    const row = rows[0] as Record<string, unknown> | undefined
    if (!row) return null
    const base = runRow(row)
    if (base.score)
      Object.assign(base.score, {
        runId: String(row.id),
        note: row.note == null ? null : String(row.note),
        scoredBy: String(row.scored_by),
        updatedAt: iso(row.score_updated_at)!,
      })
    const lenses = await tx`
      SELECT l.*, rv.project_id AS review_project_id, rv.recorded_at, rv.completed_at,
        rv.tier, rv.patch_id, rv.commit_message,
        COALESCE(json_agg(f ORDER BY f.ordinal) FILTER (WHERE f.id IS NOT NULL), '[]') AS findings
      FROM review_lens l JOIN review rv ON rv.id=l.review_id LEFT JOIN review_finding f ON f.review_lens_id=l.id
      WHERE l.run_id=${input.id}::uuid GROUP BY l.id, rv.id ORDER BY rv.recorded_at DESC, l.id DESC
    `
    const detail = presentation(row)
    for (const key of [
      'delivery',
      'quality',
      'fidelity',
      'scoredAt',
      'note',
      'scoredBy',
      'scoreUpdatedAt',
    ])
      delete detail[key]
    return {
      ...detail,
      ...base,
      score: base.score,
      reviews: lenses.map((lens: Record<string, unknown>) => presentation(lens)),
    } as RecordRunDetail
  })
}
