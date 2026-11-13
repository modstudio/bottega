// concern: MCP workflow advance adapter
/** Resolves MCP evidence and live autonomy before closing a workflow step. */

import type { z } from 'zod'
import { assertRecordShape } from '../../../shared/record-shape.ts'
import { db } from '../database/db.ts'
import {
  type ContextMomentPorts,
  workflowNextGatherFailure,
} from '../doc/context-moment-adapter.ts'
import { resolveGateIdentifier } from '../gate/gate-identifier.ts'
import { resolveReviewIdentifier } from '../review/review-identifier.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import { resolveProbeArtifact } from '../workflow/probe-identifier.ts'
import { workflowNextContextMoment } from '../workflow/workflow-context-moment.ts'
import { workflowKeyOf } from '../workflow/workflow-cursor-arguments.ts'
import { resolveCursorLiveAutonomy } from '../workflow/workflow-cursor-live-autonomy.ts'
import { productionWorkflowFloorPorts } from '../workflow/workflow-production-floor-ports.ts'
import { type HubTaskReader, resolveHubTaskReference } from '../workflow/workflow-task-reference.ts'
import {
  closeCursorWithTextCopyResult,
  productionWorkflowTextDocumentPorts,
  type WorkflowTextDocumentPorts,
} from '../workflow/workflow-text-copy.ts'
import { collectContextMomentReports, resultWithContextReports } from './mcp-context-reports.ts'
import { resolveMcpLinkedWorkflowCursor } from './mcp-workflow-cursor.ts'
import type { nextWorkflowStepInputSchema } from './mcp-workflow-input.ts'

const workflowRunEvidence = (run: string | number | undefined) =>
  run === undefined ? undefined : resolveRunIdentifier(db(), run)

function assertAdvanceRecordShapes(
  note: string,
  selfRuling?: string,
  basis?: string,
  question?: string,
): void {
  assertRecordShape('step note', note)
  if (selfRuling !== undefined) assertRecordShape('self-ruling', selfRuling)
  if (basis !== undefined) assertRecordShape('basis', basis)
  if (question !== undefined) assertRecordShape('open question', question)
}

export async function advanceWorkflow(
  {
    slug,
    project,
    mode,
    args,
    note,
    outcome,
    ruling,
    self_ruling,
    self_ruling_basis,
    question,
    review,
    gate,
    run,
    artifact,
    task,
    defer,
    satisfies,
    cursor,
  }: z.infer<typeof nextWorkflowStepInputSchema>,
  hubTaskReader?: HubTaskReader,
  workflowTextDocuments: WorkflowTextDocumentPorts = productionWorkflowTextDocumentPorts,
  contextMomentPorts?: ContextMomentPorts,
) {
  assertAdvanceRecordShapes(note, self_ruling, self_ruling_basis, question)
  if (self_ruling_basis !== undefined && self_ruling === undefined)
    throw new Error(
      'self_ruling_basis requires self_ruling; pass both inputs, or omit self_ruling_basis',
    )
  const workflowArgs = args ?? {}
  const { context, effectiveMode } = await resolveMcpLinkedWorkflowCursor(
    slug,
    project,
    mode,
    workflowArgs,
    cursor,
    'next_workflow_step',
    'pass the mode argument',
    hubTaskReader,
  )
  const adoptedTask = task ? await resolveHubTaskReference(project, task, hubTaskReader) : null
  const advanceContext = { ...context, adoptionTaskRecordId: adoptedTask?.record_id ?? null }
  const live = await resolveCursorLiveAutonomy({
    slug,
    project,
    mode: effectiveMode,
    args: workflowArgs,
    context,
    cursor,
  })
  const storedSelfRuling = self_ruling?.trim()
  const result = await closeCursorWithTextCopyResult(
    {
      action: 'next',
      project,
      workflow: slug,
      mode: effectiveMode,
      key: workflowKeyOf(workflowArgs) || undefined,
      cursor,
      args: workflowArgs,
      context: advanceContext,
      note,
      evidence: {
        ruling,
        review: review === undefined ? undefined : resolveReviewIdentifier(db(), review),
        gate: gate === undefined ? undefined : resolveGateIdentifier(db(), gate),
        run: workflowRunEvidence(run),
        artifact: resolveProbeArtifact(db(), artifact),
        task,
        defer,
        satisfies,
      },
      floorPorts: productionWorkflowFloorPorts(),
      selfRuling:
        storedSelfRuling === undefined
          ? undefined
          : {
              ruling: storedSelfRuling,
              basis: self_ruling_basis ?? '',
              question,
              channel: 'mcp',
            },
      outcome,
      live,
    },
    undefined,
    hubTaskReader,
    workflowTextDocuments,
  )
  try {
    const moment = workflowNextContextMoment(
      {
        cursorRecordId: result.cursorRecordId,
        workflowKey: result.workflowKey,
        workflow: slug,
        cursor: result.cursorNumber,
        finished: result.finished,
        stepSlug: result.stepSlug,
        stepTitle: result.stepTitle,
      },
      result.selfRulingQuestionNumber,
      storedSelfRuling,
    )
    return resultWithContextReports(
      result.text,
      await collectContextMomentReports(moment, contextMomentPorts),
    )
  } catch (error) {
    return resultWithContextReports(result.text, [
      workflowNextGatherFailure(result.workflowKey, result.cursorRecordId, error),
    ])
  }
}
