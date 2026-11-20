// concern: keyed run cursor admission adapter
/** Gathers process and storage facts for keyed-turn admission and records its override. */

import { classifyCaller, resolveCallerIdentity } from '../caller-classification.ts'
import { db } from '../database/db.ts'
import { recordRunWarning } from '../events.ts'
import { projectByRecordId } from '../project/project-read.ts'
import { openQuestionStages } from '../question-store/question-store-read.ts'
import { inheritedRunFacts } from '../run/run-claim-inheritance.ts'
import { rootRunRecordId } from '../run/run-root-record.ts'
import { checkKeyedRunCursorAdmission, type KeyedRunTurn } from './keyed-run-cursor-admission.ts'

/** Read the calling harness identity and its open keyed workflow cursors. */
export function harnessCursorAdapter() {
  const caller = classifyCaller(process.env)
  const identity = caller.kind === 'harness' ? resolveCallerIdentity(caller, null) : null
  return {
    harnessSession: identity?.kind === 'identity' ? identity.session : null,
    readOpenCursors: async (session: string) =>
      (await openQuestionStages(db(), session)).map((cursor) => ({
        recordId: cursor.record_id,
        number: cursor.number,
        project: cursor.project,
        workflowKey: cursor.workflow_key,
        stepSlug: cursor.step_slug,
      })),
  }
}

type AdmitKeyedTurnInput =
  | { runId: string; turn: 'answer' }
  | {
      runId: string
      turn: Exclude<KeyedRunTurn, 'start' | 'answer'>
      overrideReason?: string
      fromOperator: boolean
      cursor?: number
    }

/** Admit one later turn using its chain root's key, project, and cursor binding. */
export async function admitKeyedTurn(input: AdmitKeyedTurnInput) {
  const rootId = rootRunRecordId(input.runId)
  const facts = inheritedRunFacts(rootId)
  const project = facts.project_record_id ? projectByRecordId(facts.project_record_id) : null
  const adapter = harnessCursorAdapter()
  const decision = await checkKeyedRunCursorAdmission(
    {
      turn: input.turn,
      key: facts.launch_key ?? undefined,
      project: project?.name ?? null,
      bindingPresent: facts.cursor_record_id !== null,
      harnessSession: adapter.harnessSession,
      overrideReason: input.turn === 'answer' ? undefined : input.overrideReason,
      fromOperator: input.turn === 'answer' ? false : input.fromOperator,
      cursor: input.turn === 'answer' ? undefined : input.cursor,
    },
    adapter.readOpenCursors,
  )
  if (decision.kind === 'refuse') throw new Error(decision.message)
  return {
    warning: decision.kind === 'allow-with-override' ? decision.warning : null,
    binding: decision.kind === 'allow' ? decision.binding : undefined,
  }
}

/** Record an admission override on the run whose turn it admitted. */
export function recordKeyedTurnOverride(runId: string, warning: string | null): void {
  if (warning) recordRunWarning(runId, warning)
}
