// concern: workflow-floor-adapter
/** Gathers floor facts and applies prerequisite and evidence-floor decisions. */

import type { Database } from 'bun:sqlite'
import { nowIso } from '../database/db.ts'
import { taskReader } from './task-read-port.ts'
import { cursorName, workflowCursorTakeoverRemedy } from './workflow-cursor-format.ts'
import type { SelectableCursorRow, WorkflowCursorContext } from './workflow-cursor-selection.ts'
import { currentStepActivatedAt, reentryBoundFloorInput } from './workflow-cursor-trail.ts'
import { foreignCursorOwner } from './workflow-cursor-transition.ts'
import { gatherNoAcceptedFindingsFact } from './workflow-dispatch-waiver-evidence.ts'
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
import type { DispatchWaiverFact, StepRunObligation } from './workflow-run-obligation.ts'
import { gatherWorkflowRunChains } from './workflow-run-obligation-evidence.ts'

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

function gatherDispatchWaiverFacts(
  row: FloorCursor,
  floors: Floor[],
  step: StepRunObligation,
  ports: FloorEvidencePorts,
  args: Record<string, string>,
  database: Database,
): { facts: DispatchWaiverFact[]; refusal?: Extract<FloorDecision, { action: 'refuse' }> } {
  const facts: DispatchWaiverFact[] = []
  const checksReviewOwed = floors.some(({ kind }) => kind === 'review-owed')
  const gathersNoLensOwed = step.dispatchWaivedBy?.includes('no-lens-owed') ?? false
  if (row.enforcement === 'floors' && (checksReviewOwed || gathersNoLensOwed)) {
    const reviewOwed = invokeFloorEvidencePort(
      ports,
      'reviewOwed',
      () => {
        throw new Error('floor evidence port reviewOwed has no implementation')
      },
      row.project,
      args,
    )
    if (checksReviewOwed && reviewOwed.action === 'refuse') return { facts, refusal: reviewOwed }
    if (reviewOwed.noLensOwed) facts.push('no-lens-owed')
  }
  if (row.enforcement === 'floors' && step.dispatchWaivedBy?.includes('no-accepted-findings')) {
    const gathered = invokeFloorEvidencePort(
      ports,
      'noAcceptedFindings',
      gatherNoAcceptedFindingsFact,
      row.project,
      args,
      database,
    )
    if (gathered.action === 'refuse') return { facts, refusal: gathered }
    facts.push(...gathered.facts)
  }
  return { facts }
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
    ? await readDescendantTaskFacts(row.project, row.workflow_key)
    : []
  const evidenceFloors = selectEpicStartFloors(declaredEvidenceFloors, {
    workflow: row.workflow_slug,
    step: row.step_slug,
    hasChildren: taskRows.some((task) => task.parentKey === row.workflow_key),
  })
  const waiver = gatherDispatchWaiverFacts(row, floors, step, ports, args, database)
  if (waiver.refusal) return waiver.refusal
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
  validated.metDispatchWaiverFacts = waiver.facts
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
    ...(foreignOwner
      ? { cursorTakeoverRemedy: workflowCursorTakeoverRemedy(row, foreignOwner) }
      : {}),
    ...reentryBoundFloorInput(requireRuling, row.closed, row.step_slug),
  })
}

type DescendantTaskFact = {
  key: string
  parentKey: string | null
  status: string | null
  statusCategory: string | null
}

/** Read each descendant set once without downloading the project's unrelated tasks. */
export async function readDescendantTaskFacts(
  project: string,
  root: string,
): Promise<DescendantTaskFact[]> {
  const rows: DescendantTaskFact[] = []
  const pending = [root]
  const visited = new Set<string>()
  const discovered = new Set([root])
  while (pending.length) {
    const parent = pending.shift()!
    if (visited.has(parent)) continue
    visited.add(parent)
    const children = await taskReader().list({ project, parent })
    for (const child of children) {
      if (discovered.has(child.key)) continue
      discovered.add(child.key)
      rows.push({
        key: child.key,
        parentKey: child.parent_key,
        status: child.status,
        statusCategory: child.status_category,
      })
      pending.push(child.key)
    }
  }
  return rows
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
