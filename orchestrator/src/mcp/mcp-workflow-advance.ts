// concern: MCP workflow advance adapter
/** Resolves MCP evidence and live autonomy before closing a workflow step. */

import type { z } from 'zod'
import { db } from '../database/db.ts'
import { resolveGateIdentifier } from '../gate/gate-identifier.ts'
import { resolveReviewIdentifier } from '../review/review-identifier.ts'
import { resolveRunIdentifier } from '../run/run-identifier.ts'
import { resolveProbeArtifact } from '../workflow/probe-identifier.ts'
import { workflowKeyOf } from '../workflow/workflow-cursor-arguments.ts'
import { resolveCursorLiveAutonomy } from '../workflow/workflow-cursor-live-autonomy.ts'
import { resolveMcpCursorContext } from '../workflow/workflow-cursor-selection.ts'
import { resolveLinkedWorkflowCursorMode } from '../workflow/workflow-task-linking.ts'
import { type HubTaskReader, resolveHubTaskReference } from '../workflow/workflow-task-reference.ts'
import {
  closeCursorWithTextCopy,
  productionWorkflowTextDocumentPorts,
  type WorkflowTextDocumentPorts,
} from '../workflow/workflow-text-copy.ts'
import type { nextWorkflowStepInputSchema } from './mcp-workflow-input.ts'

const workflowRunEvidence = (run: string | number | undefined) =>
  run === undefined ? undefined : resolveRunIdentifier(db(), run)

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
) {
  if (self_ruling_basis !== undefined && self_ruling === undefined)
    throw new Error(
      'self_ruling_basis requires self_ruling; pass both inputs, or omit self_ruling_basis',
    )
  const workflowArgs = args ?? {}
  const context = await resolveMcpCursorContext(project, workflowArgs, hubTaskReader)
  const adoptedTask = task ? await resolveHubTaskReference(project, task, hubTaskReader) : null
  const advanceContext = { ...context, adoptionTaskRecordId: adoptedTask?.record_id ?? null }
  const effectiveMode = resolveLinkedWorkflowCursorMode(
    slug,
    project,
    mode,
    workflowArgs,
    context,
    'next_workflow_step',
    'pass the mode argument',
    undefined,
    cursor,
  )
  const live = await resolveCursorLiveAutonomy({
    slug,
    project,
    mode: effectiveMode,
    args: workflowArgs,
    context,
    cursor,
  })
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
  return { content: [{ type: 'text' as const, text: result }] }
}
