// concern: workflow cursor serving
/** Resolves one served step and applies its hosted-first cursor transition. */

import type { Database } from 'bun:sqlite'
import { nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import {
  taskFlowWriteTarget,
  writeHostedTaskFlow,
} from '../record/record-task-flow-write-client.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import type { AutonomyResolution, LiveCursorAutonomy } from './autonomy.ts'
import { taskFlowLocalStore } from './task-flow-store.ts'
import type { TaskFlowIntentInput } from './task-flow-store-types.ts'
import { type CommitCountPort, readCommitsPastLanding } from './workflow-compose-branch.ts'
import { selectWorkflowCursorForKeyAdoption } from './workflow-cursor-adoption.ts'
import { resolveCursorArguments, workflowKeyOf } from './workflow-cursor-arguments.ts'
import { cursorAutonomy } from './workflow-cursor-autonomy.ts'
import { insertWorkflowCursor } from './workflow-cursor-compose.ts'
import {
  foreignCursorOwnerNotice,
  formatCursorOpened,
  formatCursorResumed,
} from './workflow-cursor-format.ts'
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
  cursorOwnerAfter,
  cursorValue,
  decideCursorCompositionInput,
  decideCursorStart,
  decideCursorTransition,
  stepPass,
  workflowCursorStepSuccessor,
} from './workflow-cursor-transition.ts'
import { resolveWorkflowStepReference } from './workflow-step-reference.ts'
import { followTaskCursorClaim } from './workflow-task-claim.ts'
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
      : await findWorkflowCursor(project, slug, mode, args, context, database, cursor)
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
    ? ((await selectUntouchedKeylessWorkflowCursor(
        { project, workflow: slug, mode },
        context.session,
        database,
        context.taskFlowClient,
      )) as CursorRow | null)
    : (handled ?? (await findWorkflowCursor(project, slug, mode, args, context, database, cursor)))
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
    refuseMissingWorkflowArguments(prepared.composition)
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

function refuseMissingWorkflowArguments(composition: ReturnType<typeof composeWorkflow>): void {
  if (composition.needs.arguments)
    throw new Error(
      `missing required arguments: ${composition.needs.arguments.map(({ name }) => name).join(', ')}`,
    )
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
                sessionId: cursorOwnerAfter('serve', row.session_id, context.session),
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
  if ((decision.move || decision.resume) && row.state === 'awaiting-ruling')
    await closeOpenWorkflowQuestion(row.record_id, 'advanced-without-ruling', at, database)
  writeTransaction(() => {
    const store = taskFlowLocalStore(database)
    const result = store.write('stage-update', payload, hosted)
    const revision = result.revisions[row.record_id]!
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

async function prepareWorkflowStepKeyAdoption(input: {
  slug: string
  project: string
  args: Record<string, string>
  mode: string
  context: WorkflowCursorContext
  database: Database
  cursor?: number
}) {
  const selected = await selectWorkflowCursorForKeyAdoption({
    project: input.project,
    workflow: input.slug,
    mode: input.mode,
    args: input.args,
    cursor: input.cursor,
    context: input.context,
    database: input.database,
  })
  if (selected.adopted)
    await followTaskCursorClaim({
      project: input.project,
      taskKey: workflowKeyOf(input.args),
      session: input.context.session,
      verb: 'compose',
      database: input.database,
    })
  return selected.adopted ? selected.row?.id : undefined
}

function serveNotices(input: {
  row: CursorRow
  session?: string | null
  opensCursor: boolean
  suppliedCursor?: number
  slug: string
  mode: string
  requested: { slug: string }
  requestedIndex: number
  decision: Extract<ReturnType<typeof decideCursorTransition>, { action: 'serve' }>
}): string {
  const openNotice = input.opensCursor
    ? formatCursorOpened({
        cursor: input.row.id,
        workflow: input.slug,
        mode: input.mode,
        key: input.row.workflow_key,
        step: 1,
        stepSlug: input.row.step_slug,
      })
    : !input.suppliedCursor && input.row.workflow_key
      ? formatCursorResumed({
          cursor: input.row.id,
          key: input.row.workflow_key,
          step: input.row.ordinal + 1,
          stepSlug: input.row.step_slug,
        })
      : undefined
  const redirectNotice =
    input.decision.slug !== input.requested.slug
      ? `Requested step ${input.requestedIndex + 1} ${input.requested.slug}; serving active step ${input.decision.ordinal + 1} ${input.decision.slug}.`
      : undefined
  return [openNotice, redirectNotice, foreignCursorOwnerNotice(input.row, input.session)]
    .filter(Boolean)
    .join('\n')
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
  await readThroughWorkflowCursorContext(project, context, database)
  await linkResolvedWorkflowTask(project, context, database)
  const selectedCursor = await prepareWorkflowStepKeyAdoption({
    slug,
    project,
    mode,
    args,
    cursor,
    context,
    database,
  })
  const preparedCursor = selectedCursor ?? cursor
  let prepared = await prepareStepServe(
    slug,
    project,
    stepSlug,
    args,
    mode,
    context,
    database,
    autonomy,
    preparedCursor,
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
    preparedCursor,
    live,
    commitCount,
  )
  let { row } = prepared
  const { opensCursor, composition, requested, index, input, resolvedArguments } = prepared
  const decision = serveDecision(prepared, slug, mode, args)
  if (!row) {
    refuseMissingWorkflowArguments(composition)
    row = await insertWorkflowCursor(composition, context, database, autonomy, commitCount)
  }
  await applyServeTransition(row, decision, context, database, resolvedArguments)
  const served = await withWorkflowTextFacts(
    await getWorkflowStep(
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
    context.taskFlowClient,
  )
  const flow = (JSON.parse(row.closed) as CursorTrailEntry[]).filter(isClosedStep)
  return {
    ...served,
    next: workflowCursorStepSuccessor(composition.steps, flow, decision.ordinal),
    cursor: row.id,
    flow,
    pass: stepPass(flow, composition.steps, decision.ordinal),
    notice: serveNotices({
      row,
      session: context.session,
      opensCursor,
      suppliedCursor: cursor,
      slug,
      mode,
      requested,
      requestedIndex: index,
      decision,
    }),
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
