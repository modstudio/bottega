// concern: workflow-floor-adapter
/** Gathers floor facts and applies prerequisite and evidence-floor decisions. */

import type { Database } from 'bun:sqlite'
import { nowIso } from '../database/db.ts'
import { cursorName, workflowCursorTakeoverRemedy } from './workflow-cursor-format.ts'
import type { SelectableCursorRow, WorkflowCursorContext } from './workflow-cursor-selection.ts'
import { currentStepActivatedAt, reentryBoundFloorInput } from './workflow-cursor-trail.ts'
import { foreignCursorOwner } from './workflow-cursor-transition.ts'
import {
  decideFloorSatisfaction,
  type EnforcementMode,
  type Floor,
  type FloorDecision,
} from './workflow-floor.ts'
import type { FloorEvidencePorts, WorkflowEvidenceInput } from './workflow-floor-evidence.ts'
import { gatherValidatedEvidence } from './workflow-floor-evidence-gather.ts'
import { invokeFloorEvidencePort } from './workflow-floor-evidence-replay.ts'
import { openWorkflowObligations } from './workflow-obligation-floor.ts'

type FloorCursor = Pick<
  SelectableCursorRow,
  | 'id'
  | 'record_id'
  | 'project'
  | 'workflow_slug'
  | 'mode_slug'
  | 'workflow_key'
  | 'task_record_id'
  | 'args'
  | 'session_id'
  | 'created_at'
  | 'ordinal'
  | 'step_slug'
  | 'state'
  | 'closed'
> & { enforcement: EnforcementMode | null }

export async function applyFloorDecision(
  row: FloorCursor,
  floors: Floor[],
  evidence: WorkflowEvidenceInput,
  ports: FloorEvidencePorts,
  finishing: boolean,
  database: Database,
  client?: WorkflowCursorContext['taskFlowClient'],
  requireRuling = false,
  selfRulingId?: number,
  callerSession?: string | null,
): Promise<FloorDecision> {
  const args = JSON.parse(row.args) as Record<string, string>
  const foreignOwner = foreignCursorOwner(row, callerSession)
  const evidenceFloors = floors.filter(({ kind }) => kind !== 'review-owed')
  if (row.enforcement === 'floors' && evidenceFloors.length !== floors.length) {
    const reviewOwed = invokeFloorEvidencePort(
      ports,
      'reviewOwed',
      () => {
        throw new Error('floor evidence port reviewOwed has no implementation')
      },
      row.project,
      args,
    )
    if (reviewOwed.action === 'refuse') return reviewOwed
  }
  const validated = await gatherValidatedEvidence({
    cursorId: row.record_id,
    cursorState: row.state,
    identity: {
      project: row.project,
      workflowKey: row.workflow_key,
      workflowTaskRecordId: row.task_record_id,
      branch: args.branch?.trim() || null,
      worktree: args.worktree?.trim() || null,
      session: row.session_id,
      createdAt: row.created_at,
      stepActivatedAt: currentStepActivatedAt(
        row,
        cursorName(row.workflow_slug, row.mode_slug, row.workflow_key),
      ),
    },
    stepOrdinal: row.ordinal + 1,
    stepSlug: row.step_slug,
    floors: evidenceFloors,
    evidence,
    ports,
    d: database,
    taskFlowClient: client,
  })
  if (selfRulingId !== undefined)
    validated.ruling = {
      id: selfRulingId,
      answered: true,
      answeredByOperator: false,
      boundToCursor: true,
      boundToStep: true,
      answeredAt: nowIso(),
    }
  return decideFloorSatisfaction({
    floors: evidenceFloors,
    evidence: validated,
    enforcement: row.enforcement ?? 'note-only',
    finishing,
    openObligations: await openWorkflowObligations(row.record_id, database, client),
    ...(foreignOwner
      ? { cursorTakeoverRemedy: workflowCursorTakeoverRemedy(row, foreignOwner) }
      : {}),
    ...reentryBoundFloorInput(requireRuling, row.closed, row.step_slug),
  })
}
