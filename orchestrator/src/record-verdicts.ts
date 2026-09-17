// concern: record-verdicts
/** Owns tenant-bound hosted run verdicts and evidence exclusion. Must not know local cache, CLI, or HTTP. */
import { SQL } from 'bun'
import { DELIVERY, type Delivery, FIDELITY, type Fidelity, QUALITY, type Quality } from './score.ts'

export class RecordVerdictError extends Error {
  status: 400 | 404 | 409
  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message)
    this.status = status
  }
}

type Tenant = { url: string; userId: string; spaceId: string }
type RecordCursor = { at: string; id: string }

export type RecordScore = {
  runId: string
  delivery: Delivery | null
  quality: Quality | null
  fidelity: Fidelity | null
  note: string | null
  scoredAt: string | null
  scoredBy: string | null
  updatedAt: string
  evidenceExcluded: string | null
}

const iso = (value: unknown) => (value == null ? null : new Date(String(value)).toISOString())

async function tenant<T>(input: Tenant, read: (tx: SQL) => Promise<T>): Promise<T> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await tx`SELECT set_config('app.user_id', ${input.userId}, true)`
      await tx`SELECT set_config('app.space_id', ${input.spaceId}, true)`
      return read(tx)
    })
  } finally {
    await client.close()
  }
}

export function refuseScoreVerdict(input: {
  delivery: string
  quality: string | null
  fidelity: string | null
}): string | null {
  if (!DELIVERY.includes(input.delivery as Delivery)) {
    return `delivery must be one of: ${DELIVERY.join(' | ')}`
  }
  if (input.delivery === 'none' && input.quality) {
    return "delivery 'none' takes no quality: there was nothing to judge"
  }
  if (
    input.delivery !== 'none' &&
    (!input.quality || !QUALITY.includes(input.quality as Quality))
  ) {
    return `delivery '${input.delivery}' needs a quality: ${QUALITY.join(' | ')}`
  }
  if (input.fidelity && !FIDELITY.includes(input.fidelity as Fidelity)) {
    return `fidelity must be one of: ${FIDELITY.join(' | ')}`
  }
  return null
}

export async function upsertRecordScore(
  input: Tenant & {
    id: string
    delivery: Delivery
    quality: Quality | null
    fidelity: Fidelity | null
    note: string | null
    scoredAt: string
    scoredBy: string
  },
): Promise<void> {
  const refusal = refuseScoreVerdict(input)
  if (refusal) throw new RecordVerdictError(refusal)
  return tenant(input, async (tx) => {
    await tx`
      INSERT INTO run_score (
        run_id, space_id, delivery, quality, fidelity, note, scored_at, scored_by, updated_at
      ) VALUES (
        ${input.id}::uuid, ${input.spaceId}::uuid, ${input.delivery}, ${input.quality},
        ${input.fidelity}, ${input.note}, ${input.scoredAt}::timestamptz, ${input.scoredBy},
        ${input.scoredAt}::timestamptz
      )
      ON CONFLICT (run_id) DO UPDATE SET
        delivery=excluded.delivery,
        quality=excluded.quality,
        fidelity=excluded.fidelity,
        note=CASE
          WHEN run_score.note IS NULL OR trim(run_score.note) = '' THEN excluded.note
          WHEN excluded.note IS NULL OR trim(excluded.note) = '' THEN run_score.note
          ELSE run_score.note || E'\n\n--- re-scored ' || excluded.scored_at || E' ---\n' || excluded.note
        END,
        scored_at=excluded.scored_at,
        scored_by=excluded.scored_by,
        updated_at=excluded.updated_at
    `
  })
}

export async function voidRecordRun(input: Tenant & { id: string; reason: string }): Promise<void> {
  return tenant(input, async (tx) => {
    const now = new Date().toISOString()
    const runs =
      await tx`SELECT id FROM run WHERE space_id=${input.spaceId}::uuid AND id=${input.id}::uuid`
    if (runs.length) {
      await tx`
        UPDATE run
        SET evidence_excluded=${input.reason}, updated_at=${now}::timestamptz
        WHERE id=${input.id}::uuid AND space_id=${input.spaceId}::uuid
      `
    }
    await tx`
      INSERT INTO run_exclusion (run_id, space_id, reason, excluded_at)
      VALUES (${input.id}::uuid, ${input.spaceId}::uuid, ${input.reason}, ${now}::timestamptz)
      ON CONFLICT (run_id) DO UPDATE SET reason=excluded.reason, excluded_at=excluded.excluded_at
    `
  })
}

export async function listRecordScores(
  input: Tenant & { updatedSince?: string; limit: number; cursor: RecordCursor | null },
): Promise<RecordScore[]> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT
        COALESCE(s.run_id, e.run_id) AS run_id,
        s.delivery, s.quality, s.fidelity, s.note, s.scored_at, s.scored_by,
        COALESCE(s.updated_at, e.excluded_at) AS updated_at,
        COALESCE(r.evidence_excluded, e.reason) AS evidence_excluded
      FROM run_score s
      FULL OUTER JOIN run_exclusion e ON e.run_id=s.run_id AND e.space_id=s.space_id
      LEFT JOIN run r ON r.id=COALESCE(s.run_id, e.run_id)
      WHERE COALESCE(s.space_id, e.space_id)=${input.spaceId}::uuid
        AND (
          ${input.updatedSince ?? null}::timestamptz IS NULL
          OR COALESCE(s.updated_at, e.excluded_at) > ${input.updatedSince ?? null}::timestamptz
        )
        AND (
          ${input.cursor?.at ?? null}::timestamptz IS NULL
          OR (COALESCE(s.updated_at, e.excluded_at), COALESCE(s.run_id, e.run_id))
            > (${input.cursor?.at ?? null}::timestamptz, ${input.cursor?.id ?? null}::uuid)
        )
      ORDER BY COALESCE(s.updated_at, e.excluded_at), COALESCE(s.run_id, e.run_id)
      LIMIT ${input.limit + 1}
    `
    return rows.map((row: Record<string, unknown>) => ({
      runId: String(row.run_id),
      delivery: row.delivery == null ? null : (String(row.delivery) as Delivery),
      quality: row.quality == null ? null : (String(row.quality) as Quality),
      fidelity: row.fidelity == null ? null : (String(row.fidelity) as Fidelity),
      note: row.note == null ? null : String(row.note),
      scoredAt: iso(row.scored_at),
      scoredBy: row.scored_by == null ? null : String(row.scored_by),
      updatedAt: iso(row.updated_at)!,
      evidenceExcluded: row.evidence_excluded == null ? null : String(row.evidence_excluded),
    }))
  })
}

export async function countRecordScores(input: Tenant): Promise<{ scores: number; voids: number }> {
  return tenant(input, async (tx) => {
    const scores =
      await tx`SELECT count(*)::integer AS n FROM run_score WHERE space_id=${input.spaceId}::uuid`
    const voids =
      await tx`SELECT count(*)::integer AS n FROM run_exclusion WHERE space_id=${input.spaceId}::uuid`
    return { scores: Number(scores[0]?.n ?? 0), voids: Number(voids[0]?.n ?? 0) }
  })
}
