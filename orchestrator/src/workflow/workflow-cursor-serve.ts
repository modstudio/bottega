// concern: workflow cursor serving
/** Resolves one served step and applies its hosted-first cursor transition. */

import type { Database } from 'bun:sqlite'
import { nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { machineId } from '../record/machine-identity.ts'
import { writeHostedTaskFlow } from '../record/record-task-flow-write-client.ts'
import { taskFlowRequestId } from '../record/record-task-flow-write-contract.ts'
import type { AutonomyResolution, LiveCursorAutonomy } from './autonomy.ts'
import { resolveTaskFlowDestination } from './task-flow-hosted-destination.ts'
import { type CommitCountPort, readCommitsPastLanding } from './workflow-compose-branch.ts'
import { applyCursorArguments, workflowKeyOf } from './workflow-cursor-arguments.ts'
import { cursorAutonomy } from './workflow-cursor-autonomy.ts'
import { insertWorkflowCursor } from './workflow-cursor-compose.ts'
import { formatCursorOpened, formatCursorResumed } from './workflow-cursor-format.ts'
import { closeOpenWorkflowQuestion } from './workflow-cursor-mutation.ts'
import { refuseInvalidServe } from './workflow-cursor-result.ts'
import type { WorkflowCloseCursor } from './workflow-cursor-row.ts'
import {
  findWorkflowCursor,
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
import { withWorkflowTextFacts } from './workflow-text.ts'
import { composeWorkflow, getWorkflowStep } from './workflows.ts'

type CursorRow = WorkflowCloseCursor
const findCursor = (...args: Parameters<typeof findWorkflowCursor>): CursorRow | null =>
  findWorkflowCursor(...args) as CursorRow | null

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
  commitCount: CommitCountPort = readCommitsPastLanding,
) {
  const handled =
    cursor === undefined ? null : findCursor(project, slug, mode, args, context, database, cursor)
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
    : (handled ?? findCursor(project, slug, mode, args, context, database, cursor))
  let row = handled ?? candidate
  const opensCursor = row === null
  const startDecision = decideCursorStart(row?.state ?? null)
  if (row && startDecision === 'reuse') applyCursorArguments(row, args, database)
  const input = decideCursorCompositionInput(row, args, mode)
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
  if (index === 0 && startDecision === 'retire')
    row = await insertWorkflowCursor(composition, context, database, autonomy, commitCount)
  return { row, opensCursor, composition, requested, index, input }
}

async function applyServeTransition(
  row: CursorRow,
  decision: Extract<ReturnType<typeof decideCursorTransition>, { action: 'serve' }>,
  context: WorkflowCursorContext,
  database: Database,
): Promise<void> {
  if (!decision.move && !decision.resume) return
  const at = nowIso()
  const destination = await resolveTaskFlowDestination(
    row.project,
    database,
    context.taskFlowClient,
  )
  const hosted = await writeHostedTaskFlow(
    'stage-update',
    {
      requestId: taskFlowRequestId('stage-update', [row.record_id, String(row.revision)]),
      stages: [
        {
          id: row.record_id,
          expectedRevision: row.revision,
          values: {
            activeOrdinal: decision.ordinal,
            activeSlug: decision.slug,
            state: 'running',
            question: null,
            sessionId: context.session ?? row.session_id,
            lastAdvancedMachineId: machineId(),
            updatedAt: at,
          },
        },
      ],
    },
    destination,
    context.taskFlowClient,
  )
  writeTransaction(() => {
    const current = database
      .query<{ revision: number }, [string]>(
        'SELECT revision FROM workflow_cursor WHERE record_id=?',
      )
      .get(row.record_id)
    if (!current || current.revision !== row.revision)
      throw new Error(
        `workflow cursor ${row.id} changed while its step was served; rerun the command`,
      )
    if (row.state === 'awaiting-ruling')
      closeOpenWorkflowQuestion(row.record_id, 'advanced-without-ruling', at, database)
    const revision = hosted?.revisions[row.record_id] ?? row.revision + 1
    database
      .query(
        `UPDATE workflow_cursor SET ordinal=?,step_slug=?,state='running',question=NULL,
         session_id=COALESCE(?,session_id),updated_at=?,opened_machine_id=COALESCE(opened_machine_id,?),
         last_advanced_machine_id=?,revision=? WHERE record_id=?`,
      )
      .run(
        decision.ordinal,
        decision.slug,
        context.session ?? null,
        at,
        machineId(),
        machineId(),
        revision,
        row.record_id,
      )
    row.revision = revision
    row.ordinal = decision.ordinal
    row.step_slug = decision.slug
    row.state = 'running'
  }, database)
}

export async function getWorkflowStepWithCursorImpl(
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
  const prepared = await prepareStepServe(
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
  const { opensCursor, composition, requested, index, input } = prepared
  const decision = decideCursorTransition(
    row ? cursorValue(row.ordinal, row.step_slug, row.state) : null,
    { kind: 'serve', ordinal: index, slug: requested.slug },
  )
  refuseInvalidServe(decision, row, composition, slug, mode, args)
  if (decision.action !== 'serve') throw new Error('invalid serve transition')
  if (!row) row = await insertWorkflowCursor(composition, context, database, autonomy, commitCount)
  await applyServeTransition(row, decision, context, database)
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
