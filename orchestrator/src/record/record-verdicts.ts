// concern: record-verdicts
/** Owns tenant-bound hosted run verdicts and evidence exclusion. Must not know local cache, CLI, or HTTP. */
import { SQL } from 'bun'
import type { Delivery, Fidelity, Quality } from '../score/score.ts'
import type { VerdictInput } from '../verdict/verdict-payload.ts'
import { refuseUnvoid, refuseVerdict, VOID_EXCLUSION_REASON } from '../verdict/verdict-rules.ts'

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

type HostedVerdict = Pick<Tenant, 'spaceId'> & VerdictInput & { id: string }

export async function validateRecordVerdict(tx: SQL, input: HostedVerdict): Promise<void> {
  const runs = await tx`
      SELECT job, failure_kind, machine_id FROM run
      WHERE id=${input.id}::uuid AND space_id=${input.spaceId}::uuid
    `
  const run = runs[0] as Record<string, unknown> | undefined
  if (!run) {
    throw new RecordVerdictError(
      'hosted run is absent; run `orch sync` to upload the run before retrying the verdict',
      404,
    )
  }
  const jobSnapshots = await tx`
      SELECT item
      FROM orch_snapshot snapshot
      CROSS JOIN LATERAL jsonb_array_elements(snapshot.payload) item
      WHERE snapshot.kind='jobs' AND snapshot.machine_id=${run.machine_id}::uuid
        AND item->>'name'=${String(run.job)}
      ORDER BY snapshot.taken_at DESC LIMIT 1
    `
  const declaredJob = jobSnapshots[0]?.item as
    | { needs?: { writesRepo?: boolean }; findings?: boolean }
    | undefined
  // A job this machine has not published, or has since renamed, leaves the
  // declaration unreadable. The axes are still judged; declaration-specific
  // rules cannot be reconstructed reliably when accepting a hosted payload.
  const grades = [input.reproduced, input.coverage, input.limits, input.overlap]
  const hasRequiredReviewGrades = grades.every((grade) => grade !== null)
  const refusal = refuseVerdict({
    delivery: input.delivery,
    quality: input.quality,
    fidelity: input.fidelity,
    job: declaredJob
      ? {
          writesRepo: Boolean(declaredJob.needs?.writesRepo),
          producesFindings: Boolean(declaredJob.findings),
          hasAnyReviewGrades: grades.some((grade) => grade !== null),
          hasRequiredReviewGrades,
        }
      : null,
    failureKind: run.failure_kind == null ? null : String(run.failure_kind),
  })
  if (refusal) throw new RecordVerdictError(refusal.message)
}

export async function upsertRecordScore(
  input: Tenant & VerdictInput & { id: string },
): Promise<void> {
  return tenant(input, async (tx) => {
    await validateRecordVerdict(tx, input)
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
      ON CONFLICT (run_id) DO UPDATE SET reason=excluded.reason, excluded_at=excluded.excluded_at,
        superseded_at=NULL, superseded_by=NULL, supersede_note=NULL
    `
  })
}

const UNVOID_MIGRATION_REMEDY =
  'hosted unvoid requires the pending record migration; apply it with `orch record migrate` before retrying'

async function supersedeRecordVoid(
  tx: SQL,
  input: Pick<Tenant, 'spaceId' | 'userId'> & { id: string; note: string },
): Promise<void> {
  const columns = await tx`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='run_exclusion'
      AND column_name IN ('superseded_at','superseded_by','supersede_note')
  `
  if (columns.length !== 3) throw new RecordVerdictError(UNVOID_MIGRATION_REMEDY, 409)
  const exclusions = await tx`
    SELECT reason, superseded_at FROM run_exclusion
    WHERE run_id=${input.id}::uuid AND space_id=${input.spaceId}::uuid
  `
  const exclusion = exclusions[0] as Record<string, unknown> | undefined
  const reason = exclusion?.reason == null ? null : String(exclusion.reason)
  const refusal = refuseUnvoid(reason)
  if (refusal) throw new RecordVerdictError(`refused: ${refusal}`, 409)
  if (exclusion?.superseded_at != null) return
  const now = new Date().toISOString()
  await tx`
    UPDATE run_exclusion
    SET superseded_at=${now}::timestamptz, superseded_by=${input.userId},
        supersede_note=${input.note}
    WHERE run_id=${input.id}::uuid AND space_id=${input.spaceId}::uuid
      AND reason=${VOID_EXCLUSION_REASON} AND superseded_at IS NULL
  `
  await tx`
    UPDATE run SET evidence_excluded=NULL, updated_at=${now}::timestamptz
    WHERE id=${input.id}::uuid AND space_id=${input.spaceId}::uuid
      AND evidence_excluded=${VOID_EXCLUSION_REASON}
  `
}

export async function unvoidRecordRun(input: Tenant & { id: string; note: string }): Promise<void> {
  return tenant(input, (tx) => supersedeRecordVoid(tx, input))
}

export async function listRecordScores(
  input: Tenant & { updatedSince?: string; limit: number; cursor: RecordCursor | null },
): Promise<RecordScore[]> {
  return tenant(input, async (tx) => {
    const rows = await tx`
      SELECT
        COALESCE(s.run_id, e.run_id) AS run_id,
        s.delivery, s.quality, s.fidelity, s.note, s.scored_at, s.scored_by,
        GREATEST(s.updated_at, e.excluded_at, e.superseded_at) AS updated_at,
        CASE WHEN e.superseded_at IS NOT NULL THEN NULL
          ELSE COALESCE(r.evidence_excluded, e.reason)
        END AS evidence_excluded
      FROM run_score s
      FULL OUTER JOIN run_exclusion e ON e.run_id=s.run_id AND e.space_id=s.space_id
      LEFT JOIN run r ON r.id=COALESCE(s.run_id, e.run_id)
      WHERE COALESCE(s.space_id, e.space_id)=${input.spaceId}::uuid
        AND (
          ${input.updatedSince ?? null}::timestamptz IS NULL
          OR GREATEST(s.updated_at, e.excluded_at, e.superseded_at)
            > ${input.updatedSince ?? null}::timestamptz
        )
        AND (
          ${input.cursor?.at ?? null}::timestamptz IS NULL
          OR (GREATEST(s.updated_at, e.excluded_at, e.superseded_at), COALESCE(s.run_id, e.run_id))
            > (${input.cursor?.at ?? null}::timestamptz, ${input.cursor?.id ?? null}::uuid)
        )
      ORDER BY GREATEST(s.updated_at, e.excluded_at, e.superseded_at),
        COALESCE(s.run_id, e.run_id)
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
    const voids = await tx`SELECT count(*)::integer AS n FROM run_exclusion
        WHERE space_id=${input.spaceId}::uuid AND superseded_at IS NULL`
    return { scores: Number(scores[0]?.n ?? 0), voids: Number(voids[0]?.n ?? 0) }
  })
}
