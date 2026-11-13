// concern: review-funnel-decision-log
/** Persists replayable funnel decisions and their outbox rows without owning command behavior. */
import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { PLATFORM_SPACE_ID } from '../../../shared/record/schema.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { nowIso, sessionId, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import { insertOutboxRow } from '../record/outbox-enqueue.ts'
import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'
import type { ReviewFunnelFacts, ReviewFunnelVerdict } from './decide-review-funnel.ts'

export type ReviewFunnelDecisionSurface = 'review-tier' | 'admission' | 'pre-push' | 'workflow'
export type ReviewFunnelDecisionOutcome = 'advice' | 'admit' | 'refuse'

export function recordReviewFunnelDecision(input: {
  database: Database
  surface: ReviewFunnelDecisionSurface
  outcome: ReviewFunnelDecisionOutcome
  facts: ReviewFunnelFacts
  verdict: ReviewFunnelVerdict
}): string {
  const recordId = newRecordId()
  const at = nowIso()
  const factsJson = JSON.stringify(input.facts)
  const verdictJson = JSON.stringify(input.verdict)
  const digest = createHash('sha256').update(factsJson).digest('hex')
  const project = input.database
    .query<{ record_id: string }, [string]>('SELECT record_id FROM project WHERE name=?')
    .get(input.facts.change.project)
  writeTransaction(() => {
    input.database
      .query(
        `INSERT INTO review_funnel_decision
         (record_id,project_record_id,surface,task_key,branch,head_commit,patch_id,path_set,
          policy_version,mode,facts_digest,facts,stack,verdict,outcome,session_id,recorded_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        recordId,
        project?.record_id ?? null,
        input.surface,
        input.facts.change.taskKey,
        input.facts.change.branch,
        input.facts.change.head,
        input.facts.change.patchId,
        input.facts.change.pathSet,
        input.verdict.policyVersion,
        input.verdict.mode,
        digest,
        factsJson,
        input.facts.stack,
        verdictJson,
        input.outcome,
        sessionId(),
        at,
      )
    insertOutboxRow(input.database, {
      recordId: newRecordId(),
      kind: 'review_funnel_decision',
      rowId: recordId,
      payload: stringifyOutboxPayload('review_funnel_decision', {
        id: recordId,
        spaceId: PLATFORM_SPACE_ID,
        projectId: project?.record_id ?? null,
        projectName: input.facts.change.project,
        machineId: machineId(),
        localId: null,
        surface: input.surface,
        taskKey: input.facts.change.taskKey,
        branch: input.facts.change.branch,
        headCommit: input.facts.change.head,
        patchId: input.facts.change.patchId,
        pathSet: JSON.parse(input.facts.change.pathSet),
        policyVersion: input.verdict.policyVersion,
        mode: input.verdict.mode,
        factsDigest: digest,
        facts: input.facts,
        stack: input.facts.stack,
        verdict: input.verdict,
        outcome: input.outcome,
        sessionId: sessionId(),
        recordedAt: at,
        withheldFields: null,
        createdAt: at,
        updatedAt: at,
      }),
      createdAt: at,
    })
  }, input.database)
  return recordId
}
