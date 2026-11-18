// concern: keyed run cursor admission
/** Decides whether cursor evidence admits a keyed run turn. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'

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

const composeRemedy = (project: string | null, key: string): string => {
  const projectName = project ?? '<project>'
  return (
    `for work not yet built, run ${PLATFORM_SLUG} workflow compose plan-task --project ${projectName} --arg key=${key}; ` +
    `to repair a defect, run ${PLATFORM_SLUG} workflow compose fix-defect --project ${projectName} --arg key=${key}; ` +
    `for a built branch, run ${PLATFORM_SLUG} workflow compose ship-task --project ${projectName} --arg key=${key} --arg branch=<branch> --arg worktree=<worktree>`
  )
}

const canOverride = (turn: KeyedRunTurn): boolean => turn !== 'answer'
const laterTurnRemedy = (
  input: Pick<KeyedRunCursorAdmissionInput, 'turn' | 'key' | 'project'>,
): string =>
  composeRemedy(input.project, input.key!) +
  (canOverride(input.turn) ? `; override with ${OVERRIDE_REMEDY}` : '')

/** Apply cursor ownership and operator-override policy without reaching process or storage. */
export function decideKeyedRunCursorAdmission(
  input: KeyedRunCursorAdmissionInput,
): KeyedRunCursorAdmission {
  if (!input.key || input.bindingPresent) {
    return { kind: 'allow' }
  }

  if (canOverride(input.turn) && input.overrideReason !== undefined) {
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
    const remedy =
      input.turn === 'start'
        ? `run from a harness session that holds the task's workflow cursor; or override with ${OVERRIDE_REMEDY}`
        : laterTurnRemedy(input)
    return {
      kind: 'refuse',
      message: renderRefusal(
        refusal(`refusing keyed run turn for task ${input.key} without a harness session`, {
          kind: 'edit',
          text: remedy,
        }),
      ),
    }
  }

  if (!input.project) {
    const remedy =
      input.turn === 'start'
        ? `run the dispatch from inside the project's checkout or pass --repo <project>; override with ${OVERRIDE_REMEDY}`
        : laterTurnRemedy(input)
    return {
      kind: 'refuse',
      message: renderRefusal(
        refusal(
          `refusing keyed run turn because the dispatch location is outside every registered project, so cursor ownership for harness session ${input.harnessSession} and task ${input.key} cannot be established`,
          {
            kind: 'edit',
            text: remedy,
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
          text: laterTurnRemedy(input),
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
            text:
              `rerun after ${PLATFORM_SLUG} machine doctor; ` +
              (input.turn === 'start'
                ? `or override with ${OVERRIDE_REMEDY}`
                : laterTurnRemedy(input)),
          },
        ),
      ),
    }
  }

  return decideKeyedRunCursorAdmission({ ...input, heldCursors })
}
