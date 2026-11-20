// concern: workflow-floor-adapter
/** Gathers floor facts and applies prerequisite and evidence-floor decisions. */

import type { Database } from 'bun:sqlite'
import { nowIso } from '../database/db.ts'
import { taskReader } from './task-read-port.ts'
import { cursorName, workflowCursorTakeoverRemedy } from './workflow-cursor-format.ts'
import type { SelectableCursorRow, WorkflowCursorContext } from './workflow-cursor-selection.ts'
import { currentStepActivatedAt, reentryBoundFloorInput } from './workflow-cursor-trail.ts'
import { foreignCursorOwner } from './workflow-cursor-transition.ts'
import { descendantTaskFacts, selectEpicStartFloors } from './workflow-epic-floor.ts'
import type { WorkflowEvidenceInput } from './workflow-evidence-input.ts'
import {
  decideFloorSatisfaction,
  type EnforcementMode,
  type Floor,
  type FloorDecision,
} from './workflow-floor.ts'
import type { FloorEvidencePorts } from './workflow-floor-evidence.ts'
import { gatherValidatedEvidence } from './workflow-floor-evidence-gather.ts'
import { invokeFloorEvidencePort } from './workflow-floor-evidence-replay.ts'
import { openWorkflowObligations } from './workflow-obligation-floor.ts'
import { gatherWorkflowRunChains } from './workflow-run-obligation-evidence.ts'

type StepRunObligation = {
  slug: string
  jobs: string[]
  dispatch?: 'required'
  dispatchWaivedBy?: Floor['kind'][]
  judges?: string[]
}

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

export function refuseForeignKeylessCursor(row: FloorCursor, callerSession?: string | null): void {
  const foreignOwner = foreignCursorOwner(row, callerSession)
  if (!row.workflow_key && foreignOwner)
    throw new Error(
      `workflow cursor ${row.id} is owned by session ${foreignOwner}; a keyless cursor changes owner only through an explicit takeover. Take it over with: ${workflowCursorTakeoverRemedy(row, foreignOwner)}`,
    )
}

export async function applyFloorDecision(
  row: FloorCursor,
  floors: Floor[],
  step: StepRunObligation,
  evidence: WorkflowEvidenceInput,
  ports: FloorEvidencePorts,
  finishing: boolean,
  database: Database,
  client?: WorkflowCursorContext['taskFlowClient'],
  requireRuling = false,
  selfRulingId?: number,
  callerSession?: string | null,
): Promise<FloorDecision> {
  const foreignOwner = foreignCursorOwner(row, callerSession)
  const args = JSON.parse(row.args) as Record<string, string>
  const declaredEvidenceFloors = floors.filter(({ kind }) => kind !== 'review-owed')
  const taskRows = declaredEvidenceFloors.some(({ kind }) => kind === 'descendants-closed')
    ? taskReader()
        .list({ project: row.project })
        .map((task) => ({
          key: task.key,
          parentKey: task.parent_key,
          status: task.status,
          statusCategory: task.status_category,
        }))
    : []
  const evidenceFloors = selectEpicStartFloors(declaredEvidenceFloors, {
    workflow: row.workflow_slug,
    step: row.step_slug,
    hasChildren: taskRows.some((task) => task.parentKey === row.workflow_key),
  })
  const externallyMetFloors: Floor['kind'][] = []
  if (row.enforcement === 'floors' && floors.some(({ kind }) => kind === 'review-owed')) {
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
    externallyMetFloors.push('review-owed')
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
  if (evidenceFloors.some(({ kind }) => kind === 'descendants-closed'))
    validated.descendants = descendantTaskFacts(row.workflow_key, taskRows)
  attachRunObligationEvidence(validated, row, step, database)
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
    workflowKey: row.workflow_key,
    step,
    externallyMetFloors,
    ...(foreignOwner
      ? { cursorTakeoverRemedy: workflowCursorTakeoverRemedy(row, foreignOwner) }
      : {}),
    ...reentryBoundFloorInput(requireRuling, row.closed, row.step_slug),
  })
}

function attachRunObligationEvidence(
  evidence: Parameters<typeof decideFloorSatisfaction>[0]['evidence'],
  row: FloorCursor,
  step: StepRunObligation,
  database: Database,
): void {
  if (step.dispatch === 'required')
    evidence.dispatchRuns = gatherWorkflowRunChains(
      row.record_id,
      step.jobs,
      database,
      row.step_slug,
    )
  if (step.judges?.length)
    evidence.judgedRuns = gatherWorkflowRunChains(row.record_id, step.judges, database)
}
