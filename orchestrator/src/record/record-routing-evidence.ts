// concern: record-routing-evidence
/** Reads the narrow, tenant-bound hosted evidence projection used by routing. */

import type { SQL } from 'bun'
import { bindTenant } from '../../../shared/record/tenant.ts'
import { recordPool } from './record-pool.ts'
import type { RecordRoutingEvidence } from './record-routing-evidence-contract.ts'

type Tenant = { url: string; userId: string; spaceId: string }
export type RecordRoutingEvidenceRow = RecordRoutingEvidence & { evidenceSequence: bigint }

export const ROUTING_EVIDENCE_RUN_FIELDS = [
  'id',
  'spaceId',
  'agent',
  'model',
  'job',
  'stack',
  'promptBytes',
  'status',
  'failureKind',
  'executor',
  'evidenceExcluded',
  'startedAt',
  'latencyMs',
  'vendorTokens',
  'modelCalls',
  'peakCallTokens',
] as const satisfies readonly (keyof RecordRoutingEvidence)[]

export const ROUTING_EVIDENCE_SCORE_FIELDS = [
  'delivery',
  'quality',
  'fidelity',
] as const satisfies readonly (keyof RecordRoutingEvidence)[]

const iso = (value: unknown) => new Date(String(value)).toISOString()
const nullableString = (value: unknown) => (value == null ? null : String(value))
const nullableNumber = (value: unknown) => (value == null ? null : Number(value))

export async function listRecordRoutingEvidence(
  input: Tenant & { limit: number; cursor: bigint | null },
): Promise<RecordRoutingEvidenceRow[]> {
  return recordPool(input.url).begin(async (tx: SQL) => {
    await bindTenant(tx, input)
    const rows = await tx`
      SELECT r.id, r.space_id, r.agent, r.model, r.job, r.stack, r.prompt_bytes,
        r.status, r.failure_kind, COALESCE(r.executor, 'external') AS executor,
        r.evidence_excluded, r.started_at, r.latency_ms, r.vendor_tokens, r.model_calls,
        r.peak_call_tokens, s.delivery, s.quality, s.fidelity, r.evidence_seq,
        COALESCE((
          SELECT array_agg(DISTINCT lens.lens ORDER BY lens.lens)
          FROM review_lens lens WHERE lens.run_id=r.id
        ), ARRAY[]::text[]) AS lenses
      FROM run r
      LEFT JOIN run_score s ON s.run_id=r.id AND s.space_id=r.space_id
      WHERE r.space_id=${input.spaceId}::uuid
        AND EXISTS (
          SELECT 1 FROM membership member
          WHERE member.space_id=r.space_id AND member.user_id=${input.userId}::uuid
        )
        AND r.probe=false
        AND r.parent_run_id IS NULL
        AND r.status IN ('ok', 'failed', 'stale')
        AND NOT (
          COALESCE(r.withheld_fields, '[]'::jsonb) ?| ${tx.array([...ROUTING_EVIDENCE_RUN_FIELDS], 'text')}
        )
        AND (
          s.run_id IS NULL OR NOT (
            COALESCE(s.withheld_fields, '[]'::jsonb) ?| ${tx.array([...ROUTING_EVIDENCE_SCORE_FIELDS], 'text')}
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM review_lens withheld_lens
          WHERE withheld_lens.run_id=r.id
            AND COALESCE(withheld_lens.withheld_fields, '[]'::jsonb) ? 'lens'
        )
        AND r.evidence_seq > ${input.cursor ?? 0}
      ORDER BY r.evidence_seq
      LIMIT ${input.limit + 1}
    `
    return rows.map((row: Record<string, unknown>) => ({
      id: String(row.id),
      spaceId: String(row.space_id),
      agent: String(row.agent),
      model: nullableString(row.model),
      job: String(row.job),
      stack: nullableString(row.stack),
      promptBytes: Number(row.prompt_bytes),
      status: String(row.status),
      failureKind: nullableString(row.failure_kind),
      executor: String(row.executor) as 'external' | 'harness',
      evidenceExcluded: nullableString(row.evidence_excluded),
      startedAt: iso(row.started_at),
      latencyMs: nullableNumber(row.latency_ms),
      vendorTokens: nullableNumber(row.vendor_tokens),
      modelCalls: nullableNumber(row.model_calls),
      peakCallTokens: nullableNumber(row.peak_call_tokens),
      delivery: nullableString(row.delivery),
      quality: nullableString(row.quality),
      fidelity: nullableString(row.fidelity),
      lenses: Array.isArray(row.lenses) ? row.lenses.map(String) : [],
      evidenceSequence: BigInt(String(row.evidence_seq)),
    }))
  })
}
