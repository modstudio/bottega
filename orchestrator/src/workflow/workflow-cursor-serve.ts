// concern: workflow cursor serving
/** Resolves one served step and applies its hosted-first cursor transition. */

import type { Database } from 'bun:sqlite'
import { nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import type { TaskFlowIntentInput } from '../record/record-task-flow-write-contract.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import type { AutonomyResolution, LiveCursorAutonomy } from './autonomy.ts'
import { taskFlowStore } from './task-flow-store.ts'
import { type CommitCountPort, readCommitsPastLanding } from './workflow-compose-branch.ts'
import { resolveCursorArguments, workflowKeyOf } from './workflow-cursor-arguments.ts'
import { cursorAutonomy } from './workflow-cursor-autonomy.ts'
import { insertWorkflowCursor } from './workflow-cursor-compose.ts'
import { formatCursorOpened, formatCursorResumed } from './workflow-cursor-format.ts'
import { closeOpenWorkflowQuestion } from './workflow-cursor-mutation.ts'
import { refuseInvalidServe } from './workflow-cursor-result.ts'
import {
  findWorkflowCursor,
  readThroughWorkflowCursorContext,
  type SelectableCursorRow,
  selectUntouchedKeylessWorkflowCursor,
  type WorkflowCursorContext,
} from './workflow-cursor-selection.ts'
import { type CursorTrailEntry, isClosedStep } from './workflow-cursor-trail.ts'
import {
  cursorValue,
  decideCursorCompositionInput,
  decideCursorStart,
  decideCursorTransition,
  stepPass,
} from './workflow-cursor-transition.ts'
import { resolveWorkflowStepReference } from './workflow-step-reference.ts'
import { linkResolvedWorkflowTask } from './workflow-task-linking.ts'
import { withWorkflowTextFacts } from './workflow-text.ts'
import { composeWorkflow, getWorkflowStep } from './workflows.ts'

type CursorRow = SelectableCursorRow

export function cursorComposition(
  row: SelectableCursorRow,
  database: Database,
  live?: LiveCursorAutonomy,
) {
  return composeWorkflow(
    row.workflow_slug,
    row.project,
    row.mode_slug,
    JSON.parse(row.args) as Record<string, string>,
    database,
    {
      version: row.workflow_version,
      versionRecordId: row.workflow_version_record_id,
      catalogueVersion: row.catalogue_version,
      catalogueVersionRecordId: row.catalogue_version_record_id,
    },
    cursorAutonomy(row, live),
  )
}

async function prepareStepServe(
  slug: string,
  project: string,
  stepSlug: string,
  args: Record<string, string>,
  mode: string,
  context: WorkflowCursorContext,
  database: Database,
  autonomy: AutonomyResolution | undefined,
  cursor: number | undefined,
  live?: LiveCursorAutonomy,
) {
  const handled =
    cursor === undefined
      ? null
      : findWorkflowCursor(project, slug, mode, args, context, database, cursor)
  const preliminary =
    handled && decideCursorStart(handled.state) === 'reuse'
      ? cursorComposition(handled, database, live)
      : composeWorkflow(slug, project, mode, args, database, { mode }, autonomy)
  const preliminaryStepSlug = resolveWorkflowStepReference(stepSlug, [
    { mode, steps: preliminary.steps.map((step) => step.slug) },
  ])
  const openingKeyless =
    cursor === undefined &&
    !workflowKeyOf(args) &&
    preliminary.steps[0]?.slug === preliminaryStepSlug
  const candidate = openingKeyless
    ? (selectUntouchedKeylessWorkflowCursor(
        { project, workflow: slug, mode },
        context.session,
        database,
      ) as CursorRow | null)
    : (handled ?? findWorkflowCursor(project, slug, mode, args, context, database, cursor))
  const row = handled ?? candidate
  const opensCursor = row === null
  const startDecision = decideCursorStart(row?.state ?? null)
  const resolvedArguments =
    row && startDecision === 'reuse' ? resolveCursorArguments(row, args, database) : null
  const compositionRow =
    row && resolvedArguments
      ? { ...row, args: resolvedArguments.encoded, closed: resolvedArguments.closed }
      : row
  const input = decideCursorCompositionInput(compositionRow, args, mode)
  const composition = composeWorkflow(
    slug,
    project,
    mode,
    input.effectiveArgs,
    database,
    input.selection,
    row && input.startDecision === 'reuse' ? cursorAutonomy(row, live) : autonomy,
  )
  const resolvedStepSlug = resolveWorkflowStepReference(stepSlug, [
    { mode, steps: composition.steps.map((step) => step.slug) },
  ])
  const index = composition.steps.findIndex((step) => step.slug === resolvedStepSlug)
  if (index < 0) throw new Error(`workflow "${slug}" has no step "${resolvedStepSlug}"`)
  const requested = composition.steps[index]!
  return { row, opensCursor, composition, requested, index, input, resolvedArguments }
}

async function refreshStepServe(
  slug: string,
  project: string,
  stepSlug: string,
  args: Record<string, string>,
  mode: string,
  context: WorkflowCursorContext,
  database: Database,
  autonomy: AutonomyResolution | undefined,
  cursor: number | undefined,
  live: LiveCursorAutonomy | undefined,
  commitCount: CommitCountPort,
) {
  await readThroughWorkflowCursorContext(project, context, database)
  await linkResolvedWorkflowTask(project, context, database)
  let prepared = await prepareStepServe(
    slug,
    project,
    stepSlug,
    args,
    mode,
    context,
    database,
    autonomy,
    cursor,
    live,
  )
  if (prepared.index === 0 && prepared.row && decideCursorStart(prepared.row.state) === 'retire') {
    await insertWorkflowCursor(prepared.composition, context, database, autonomy, commitCount)
    prepared = await prepareStepServe(
      slug,
      project,
      stepSlug,
      args,
      mode,
      context,
      database,
      autonomy,
      cursor,
      live,
    )
  }
  return prepared
}

function serveDecision(
  prepared: Awaited<ReturnType<typeof prepareStepServe>>,
  slug: string,
  mode: string,
  args: Record<string, string>,
) {
  const decision = decideCursorTransition(
    prepared.row
      ? cursorValue(prepared.row.ordinal, prepared.row.step_slug, prepared.row.state)
      : null,
    { kind: 'serve', ordinal: prepared.index, slug: prepared.requested.slug },
  )
  refuseInvalidServe(decision, prepared.row, prepared.composition, slug, mode, args)
  if (decision.action !== 'serve') throw new Error('invalid serve transition')
  return decision
}

async function applyServeTransition(
  row: CursorRow,
  decision: Extract<ReturnType<typeof decideCursorTransition>, { action: 'serve' }>,
  context: WorkflowCursorContext,
  database: Database,
  resolvedArguments: ReturnType<typeof resolveCursorArguments> | null,
): Promise<void> {
  const argumentsChanged =
    resolvedArguments !== null &&
    (resolvedArguments.encoded !== row.args || resolvedArguments.closed !== row.closed)
  if (!decision.move && !decision.resume && !argumentsChanged) return
  const at = nowIso()
  const payload: TaskFlowIntentInput<'stage-update'> = {
    requestId: taskFlowRequestId('stage-update', [row.record_id, String(row.revision)]),
    stages: [
      {
        id: row.record_id,
        expectedRevision: row.revision,
        values: {
          ...(decision.move || decision.resume
            ? {
                activeOrdinal: decision.ordinal,
                activeSlug: decision.slug,
                state: 'running' as const,
                question: null,
                sessionId: context.session ?? row.session_id,
                lastAdvancedMachineId: machineId(),
              }
            : {}),
          ...(argumentsChanged
            ? {
                arguments: resolvedArguments.args,
                closedStepNotes: JSON.parse(resolvedArguments.closed) as unknown[],
              }
            : {}),
          updatedAt: at,
        },
      },
    ],
  }
  const hosted = await writeHostedTaskFlow(
    'stage-update',
    payload,
    taskFlowWriteTarget(row.project, database),
    context.taskFlowClient,
  )
  writeTransaction(() => {
    const store = taskFlowStore(database)
    if ((decision.move || decision.resume) && row.state === 'awaiting-ruling')
      closeOpenWorkflowQuestion(row.record_id, 'advanced-without-ruling', at, database)
    const revision = store.write('stage-update', payload, hosted).revisions[row.record_id]!
    row.revision = revision
    if (resolvedArguments) {
      row.args = resolvedArguments.encoded
      row.closed = resolvedArguments.closed
    }
    if (decision.move || decision.resume) {
      row.ordinal = decision.ordinal
      row.step_slug = decision.slug
      row.state = 'running'
    }
  }, database)
}

async function serveWorkflowStepWithCursor(
  slug: string,
  project: string,
  stepSlug: string,
  args: Record<string, string>,
  mode: string,
  context: WorkflowCursorContext,
  database: Database = writableDb(),
  autonomy?: AutonomyResolution,
  cursor?: number,
  live?: LiveCursorAutonomy,
  commitCount: CommitCountPort = readCommitsPastLanding,
) {
  let prepared = await prepareStepServe(
    slug,
    project,
    stepSlug,
    args,
    mode,
    context,
    database,
    autonomy,
    cursor,
    live,
  )
  if (!(prepared.index === 0 && prepared.row && decideCursorStart(prepared.row.state) === 'retire'))
    serveDecision(prepared, slug, mode, args)
  prepared = await refreshStepServe(
    slug,
    project,
    stepSlug,
    args,
    mode,
    context,
    database,
    autonomy,
    cursor,
    live,
    commitCount,
  )
  let { row } = prepared
  const { opensCursor, composition, requested, index, input, resolvedArguments } = prepared
  const decision = serveDecision(prepared, slug, mode, args)
  if (!row) row = await insertWorkflowCursor(composition, context, database, autonomy, commitCount)
  await applyServeTransition(row, decision, context, database, resolvedArguments)
  const served = withWorkflowTextFacts(
    getWorkflowStep(
      slug,
      project,
      decision.slug,
      input.effectiveArgs,
      database,
      input.selection,
      cursorAutonomy(row, live),
    ),
    row.record_id,
    database,
  )
  const openNotice = opensCursor
    ? formatCursorOpened({
        cursor: row.id,
        workflow: slug,
        mode,
        key: row.workflow_key,
        step: 1,
        stepSlug: row.step_slug,
      })
    : !cursor && row.workflow_key
      ? formatCursorResumed({
          cursor: row.id,
          key: row.workflow_key,
          step: row.ordinal + 1,
          stepSlug: row.step_slug,
        })
      : undefined
  const redirectNotice =
    decision.slug !== requested.slug
      ? `Requested step ${index + 1} ${requested.slug}; serving active step ${decision.ordinal + 1} ${decision.slug}.`
      : undefined
  const flow = (JSON.parse(row.closed) as CursorTrailEntry[]).filter(isClosedStep)
  return {
    ...served,
    cursor: row.id,
    flow,
    pass: stepPass(flow, composition.steps, decision.ordinal),
    notice: [openNotice, redirectNotice].filter(Boolean).join('\n'),
  }
}

export async function getWorkflowStepWithCursor(
  slug: string,
  project: string,
  stepSlug: string,
  args: Record<string, string>,
  mode: string,
  context: WorkflowCursorContext,
  database: Database = writableDb(),
  live: LiveCursorAutonomy,
  cursor?: number,
  commitCount: CommitCountPort = readCommitsPastLanding,
) {
  return serveWorkflowStepWithCursor(
    slug,
    project,
    stepSlug,
    args,
    mode,
    context,
    database,
    live.resolution,
    cursor,
    live,
    commitCount,
  )
}
