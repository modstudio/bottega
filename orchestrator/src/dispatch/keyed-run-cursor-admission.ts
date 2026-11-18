// concern: keyed run cursor admission
/** Decides whether a keyed run turn is held by the calling harness session. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { classifyCaller, resolveCallerIdentity } from '../caller-classification.ts'
import { db } from '../database/db.ts'
import { projectByRecordId } from '../project/project-read.ts'
import { openQuestionStages } from '../question-store/question-store-read.ts'
import { inheritedRunFacts } from '../run/run-claim-inheritance.ts'
import { rootRunRecordId } from '../run/run-root-record.ts'

export type KeyedRunTurn = 'start' | 'continue' | 'answer' | 'retry'

type KeyedRunCursor = {
  project: string
  workflowKey: string
}

export type KeyedRunCursorAdmissionInput = {
  turn: KeyedRunTurn
  key: string | undefined
  project: string | null
  bindingPresent: boolean
  harnessSession: string | null
  heldCursors: readonly KeyedRunCursor[]
  overrideReason: string | undefined
  fromOperator: boolean
}

export type KeyedRunCursorAdmission =
  | { kind: 'allow' }
  | { kind: 'allow-with-override'; warning: string }
  | { kind: 'refuse'; message: string }

export type OpenKeyedRunCursors = (session: string) => Promise<KeyedRunCursor[]>

const OVERRIDE_OPTION = '--override-unbound'
const OVERRIDE_REMEDY = `${OVERRIDE_OPTION} "<reason>" --from-operator`
const OVERRIDE_PREFIX = 'unbound keyed run turn overridden by Shmuel Barkin: '

/** Apply cursor ownership and operator-override policy without reaching process or storage. */
export function decideKeyedRunCursorAdmission(
  input: KeyedRunCursorAdmissionInput,
): KeyedRunCursorAdmission {
  if (!input.key || input.bindingPresent) {
    return { kind: 'allow' }
  }

  if (input.overrideReason !== undefined) {
    const reason = input.overrideReason.trim()
    if (!reason) {
      return {
        kind: 'refuse',
        message: `${OVERRIDE_OPTION} requires a non-empty reason; rerun with ${OVERRIDE_REMEDY}`,
      }
    }
    if (!input.fromOperator) {
      return {
        kind: 'refuse',
        message:
          'refusing unbound keyed run turn override without operator attribution; rerun with ' +
          OVERRIDE_REMEDY,
      }
    }
    return { kind: 'allow-with-override', warning: `${OVERRIDE_PREFIX}${reason}` }
  }

  if (!input.harnessSession) {
    return {
      kind: 'refuse',
      message: renderRefusal(
        refusal(`refusing keyed run turn for task ${input.key} without a harness session`, {
          kind: 'edit',
          text: `run from a harness session that holds the task's workflow cursor; or override with ${OVERRIDE_REMEDY}`,
        }),
      ),
    }
  }

  if (!input.project) {
    return {
      kind: 'refuse',
      message: renderRefusal(
        refusal(
          `refusing keyed run turn because the dispatch location is outside every registered project, so cursor ownership for harness session ${input.harnessSession} and task ${input.key} cannot be established`,
          {
            kind: 'edit',
            text:
              `run the dispatch from inside the project's checkout or pass --repo <project>; ` +
              `override with ${OVERRIDE_REMEDY}`,
          },
        ),
      ),
    }
  }

  if (
    input.heldCursors.some(
      (cursor) => cursor.project === input.project && cursor.workflowKey === input.key,
    )
  ) {
    return { kind: 'allow' }
  }

  return {
    kind: 'refuse',
    message: renderRefusal(
      refusal(
        `refusing keyed run turn because harness session ${input.harnessSession} does not ` +
          `hold an open workflow cursor for project ${input.project} and task ${input.key}`,
        {
          kind: 'edit',
          text:
            `for work not yet built, run ${PLATFORM_SLUG} workflow compose plan-task --project ${input.project} --arg key=${input.key}; ` +
            `to repair a defect, run ${PLATFORM_SLUG} workflow compose fix-defect --project ${input.project} --arg key=${input.key}; ` +
            `for a built branch, run ${PLATFORM_SLUG} workflow compose ship-task --project ${input.project} --arg key=${input.key} --arg branch=<branch> --arg worktree=<worktree>; ` +
            `override with ${OVERRIDE_REMEDY}`,
        },
      ),
    ),
  }
}

/** Gather open cursor evidence through an injected adapter, then apply the admission decision. */
export async function checkKeyedRunCursorAdmission(
  input: Omit<KeyedRunCursorAdmissionInput, 'heldCursors'>,
  readOpenCursors: OpenKeyedRunCursors,
): Promise<KeyedRunCursorAdmission> {
  const decisionWithoutCursors = decideKeyedRunCursorAdmission({ ...input, heldCursors: [] })
  if (
    !input.key ||
    input.bindingPresent ||
    !input.harnessSession ||
    input.overrideReason !== undefined
  ) {
    return decisionWithoutCursors
  }

  let heldCursors: KeyedRunCursor[]
  try {
    heldCursors = await readOpenCursors(input.harnessSession)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      kind: 'refuse',
      message: renderRefusal(
        refusal(
          `refusing keyed run turn because open workflow cursors for harness session ${input.harnessSession} could not be read: ${reason}`,
          {
            kind: 'edit',
            text: `rerun after ${PLATFORM_SLUG} machine doctor; or override with ${OVERRIDE_REMEDY}`,
          },
        ),
      ),
    }
  }

  return decideKeyedRunCursorAdmission({ ...input, heldCursors })
}

/** Read the calling harness identity and its open keyed workflow cursors. */
export function keyedRunCursorAdmission() {
  const caller = classifyCaller(process.env)
  const identity = caller.kind === 'harness' ? resolveCallerIdentity(caller, null) : null
  return {
    harnessSession: identity?.kind === 'identity' ? identity.session : null,
    readOpenCursors: async (session: string) =>
      (await openQuestionStages(db(), session)).map((cursor) => ({
        project: cursor.project,
        workflowKey: cursor.workflow_key,
      })),
  }
}

/** Admit one later turn using its chain root's key, project, and cursor binding. */
export async function admitKeyedTurn(input: {
  runId: string
  turn: Exclude<KeyedRunTurn, 'start'>
  overrideReason?: string
  fromOperator: boolean
}): Promise<string | null> {
  const rootId = rootRunRecordId(input.runId)
  const facts = inheritedRunFacts(rootId)
  const project = facts.project_record_id ? projectByRecordId(facts.project_record_id) : null
  const adapter = keyedRunCursorAdmission()
  const decision = await checkKeyedRunCursorAdmission(
    {
      turn: input.turn,
      key: facts.launch_key ?? undefined,
      project: project?.name ?? null,
      bindingPresent: facts.cursor_record_id !== null,
      harnessSession: adapter.harnessSession,
      overrideReason: input.overrideReason,
      fromOperator: input.fromOperator,
    },
    adapter.readOpenCursors,
  )
  if (decision.kind === 'refuse') throw new Error(decision.message)
  return decision.kind === 'allow-with-override' ? decision.warning : null
}
