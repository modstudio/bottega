// concern: MCP workflow advance adapter
/** Resolves MCP evidence and live autonomy before closing a workflow step. */

import type { z } from 'zod'
import { assertRecordShape } from '../../../shared/record-shape.ts'
import { db } from '../database/db.ts'
import { applyContextMomentEffect, type ContextMomentPorts } from '../doc/context-moment-adapter.ts'
import { resolveGateIdentifier } from '../gate/gate-identifier.ts'
import { resolveReviewIdentifier } from '../review/review-identifier.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import { resolveProbeArtifact } from '../workflow/probe-identifier.ts'
import { workflowNextContextMoment } from '../workflow/workflow-context-moment.ts'
import { workflowKeyOf } from '../workflow/workflow-cursor-arguments.ts'
import { resolveCursorLiveAutonomy } from '../workflow/workflow-cursor-live-autonomy.ts'
import { selectWorkflowCursorForClose } from '../workflow/workflow-cursor-selection.ts'
import { type HubTaskReader, resolveHubTaskReference } from '../workflow/workflow-task-reference.ts'
import {
  closeCursorWithTextCopy,
  productionWorkflowTextDocumentPorts,
  type WorkflowTextDocumentPorts,
} from '../workflow/workflow-text-copy.ts'
import { resolveMcpLinkedWorkflowCursor } from './mcp-workflow-cursor.ts'
import type { nextWorkflowStepInputSchema } from './mcp-workflow-input.ts'

const workflowRunEvidence = (run: string | number | undefined) =>
  run === undefined ? undefined : resolveRunIdentifier(db(), run)

async function withContextReports(
  result: string,
  cursorRecordId: string,
  selfRuling: string | undefined,
  ports: ContextMomentPorts | undefined,
) {
  const moment = workflowNextContextMoment(cursorRecordId, selfRuling)
  const reports: string[] = []
  await applyContextMomentEffect(
    moment.taskKey,
    moment.effect,
    false,
    { log: (line) => reports.push(line), error: (line) => reports.push(line) },
    ports,
  )
  return {
    content: [
      { type: 'text' as const, text: result },
      ...reports.map((line) => ({ type: 'text' as const, text: line })),
    ],
  }
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
  assertRecordShape('step note', note)
  if (self_ruling !== undefined) assertRecordShape('self-ruling', self_ruling)
  if (self_ruling_basis !== undefined) assertRecordShape('basis', self_ruling_basis)
  if (question !== undefined) assertRecordShape('open question', question)
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
  const selected = selectWorkflowCursorForClose(
    { project, workflow: slug, mode: effectiveMode, key: workflowKeyOf(workflowArgs) || undefined },
    cursor,
    context.session,
    db(),
    context.taskRecordId,
    context.taskStatusCategory,
  )
  if (!selected) throw new Error(`workflow ${slug} has no cursor; compose the workflow first`)
  const result = await closeCursorWithTextCopy(
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
      selfRuling:
        self_ruling === undefined
          ? undefined
          : {
              ruling: self_ruling,
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
  return withContextReports(result, selected.record_id, self_ruling, contextMomentPorts)
}
