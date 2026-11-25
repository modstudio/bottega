// concern: hosted-record doctor checks
/** Reports active-space validity and local workflow-history parity with the hosted record. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { activeSpaceInvariant, RECORD_SIGN_IN_REMEDY } from '../record/active-space-invariant.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import {
  WORKFLOW_HISTORY_PARITY_TABLES,
  type WorkflowHistoryParityDiagnosis,
  workflowHistoryParityDiagnosis,
} from '../record/record-history-parity.ts'
import {
  historyUploadFingerprint,
  storedHistoryUploadFingerprint,
} from '../record/record-history-upload.ts'
import { readHeldFlowIds, readHeldQuestionIds } from '../record/record-history-upload-state.ts'
import {
  collectHostedRowState,
  hostedRowIdsAreEmpty,
  readHostedRowPresence,
} from '../record/record-hosted-row-presence.ts'
import { recordMembershipsFromIdentity } from '../record/record-space.ts'
import type { DoctorReporter } from './doctor-reporter.ts'

type Clock = () => number
type ParityLoader = () => Promise<WorkflowHistoryParityDiagnosis>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function activeSpaceDoctorDiagnosis(
  whoami: () => Promise<Awaited<ReturnType<ReturnType<typeof recordApiClient>['whoami']>>> = () =>
    recordApiClient().whoami(),
): Promise<{ line: string; failed: boolean }> {
  try {
    const decision = activeSpaceInvariant(recordMembershipsFromIdentity(await whoami()))
    if (!decision.holds) return { line: `active space   FAIL — ${decision.message}`, failed: true }
    return {
      line: `active space   pass — ${decision.active?.slug ?? decision.active?.spaceId ?? 'no space'}`,
      failed: false,
    }
  } catch (error) {
    const cause = errorMessage(error)
    return {
      line: `active space   check could not run — ${cause === RECORD_SIGN_IN_REMEDY ? `no one is signed in; ${RECORD_SIGN_IN_REMEDY}` : cause}`,
      failed: false,
    }
  }
}

export async function reportActiveSpaceDoctor(
  presentation: DoctorReporter,
  diagnose: () => Promise<{ line: string; failed: boolean }> = activeSpaceDoctorDiagnosis,
): Promise<void> {
  const diagnosis = await diagnose()
  presentation.log(diagnosis.line)
  if (diagnosis.failed) presentation.exitCode(1)
}

function rowStates(database: Database, table: 'workflow_cursor' | 'task_flow') {
  const rows =
    table === 'workflow_cursor'
      ? database
          .query<{ record_id: string; state: string }, []>(
            'SELECT record_id,state FROM workflow_cursor',
          )
          .all()
      : database
          .query<{ record_id: string; state: string }, []>('SELECT record_id,state FROM task_flow')
          .all()
  return new Map(rows.map((row) => [row.record_id, row.state]))
}

async function loadWorkflowHistoryParity(database: Database = db()) {
  const state = collectHostedRowState(database)
  const read = recordApiClient().readTaskFlowPresence
  if (!read)
    throw new Error(
      `record API lacks workflow-history presence support; release the hosted API, then retry \`${PLATFORM_SLUG} machine doctor\``,
    )
  if (hostedRowIdsAreEmpty(state.ids))
    await read({
      obligationIds: [],
      textIds: [],
      textCopyIds: [],
      questionAuditIds: [],
      questionIds: [],
      stageIds: [],
      flowIds: [],
    })
  const present = await readHostedRowPresence(state.ids, read)
  return workflowHistoryParityDiagnosis({
    local: Object.fromEntries(
      WORKFLOW_HISTORY_PARITY_TABLES.map((table) => [table, state.ids[table]]),
    ) as Pick<typeof state.ids, (typeof WORKFLOW_HISTORY_PARITY_TABLES)[number]>,
    present,
    references: state.references,
    heldFlowIds: readHeldFlowIds(database),
    heldQuestionIds: readHeldQuestionIds(database),
    storedFingerprint: storedHistoryUploadFingerprint(database),
    currentFingerprint: historyUploadFingerprint(database),
    states: {
      workflow_cursor: rowStates(database, 'workflow_cursor'),
      task_flow: rowStates(database, 'task_flow'),
    },
  })
}

export async function workflowHistoryParityDoctorDiagnosis(
  load: ParityLoader = loadWorkflowHistoryParity,
  now: Clock = Date.now,
): Promise<WorkflowHistoryParityDiagnosis> {
  const started = now()
  try {
    const diagnosis = await load()
    const elapsed = Math.max(0, now() - started)
    return {
      lines: [
        ...diagnosis.lines,
        `workflow history parity: ${diagnosis.failed ? 'fail' : 'pass'} in ${elapsed} ms`,
      ],
      failed: diagnosis.failed,
    }
  } catch (error) {
    const elapsed = Math.max(0, now() - started)
    return {
      lines: [
        `workflow history: could not establish: ${errorMessage(error)}`,
        `workflow history parity: fail in ${elapsed} ms`,
      ],
      failed: true,
    }
  }
}

export async function reportRecordDoctor(
  presentation: DoctorReporter,
  activeSpace: () => Promise<{ line: string; failed: boolean }> = activeSpaceDoctorDiagnosis,
  historyParity: () => Promise<WorkflowHistoryParityDiagnosis> = workflowHistoryParityDoctorDiagnosis,
): Promise<void> {
  await reportActiveSpaceDoctor(presentation, activeSpace)
  const parity = await historyParity()
  for (const line of parity.lines) presentation.log(line)
  if (parity.failed) presentation.exitCode(1)
}
