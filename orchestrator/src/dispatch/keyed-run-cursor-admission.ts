// concern: keyed run cursor admission
/** Decides whether cursor evidence admits a keyed run turn. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'

export type KeyedRunTurn = 'start' | 'continue' | 'answer' | 'retry'

type KeyedRunCursor = {
  recordId: string
  number: number
  project: string
  workflowKey: string
  stepSlug: string
}

type KeyedRunCursorBinding = { cursorRecordId: string; stepSlug: string }

export type KeyedRunCursorAdmissionInput = {
  turn: KeyedRunTurn
  key: string | undefined
  project: string | null
  bindingPresent: boolean
  rootCursorRecordId?: string | null
  harnessSession: string | null
  heldCursors: readonly KeyedRunCursor[]
  cursor?: number
  overrideReason: string | undefined
  fromOperator: boolean
}

export type KeyedRunCursorAdmission =
  | { kind: 'allow'; binding?: KeyedRunCursorBinding }
  | { kind: 'allow-with-override'; warning: string }
  | { kind: 'refuse'; message: string }

export type OpenKeyedRunCursors = (session: string) => Promise<KeyedRunCursor[]>

export function keyedCursorOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const cursor = Number(value)
  if (!Number.isInteger(cursor) || cursor < 1)
    throw new Error('--cursor must be a positive integer')
  return cursor
}

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

function decideMatchingCursor(
  input: KeyedRunCursorAdmissionInput,
  matching: readonly KeyedRunCursor[],
): KeyedRunCursorAdmission {
  if (input.cursor === undefined && matching.length > 1) {
    return {
      kind: 'refuse',
      message: renderRefusal(
        refusal(
          `refusing keyed run turn because harness session ${input.harnessSession} holds more than one open workflow cursor for project ${input.project} and task ${input.key}`,
          {
            kind: 'edit',
            text: `rerun with --cursor <number> naming one of: ${matching.map(({ number }) => number).join(', ')}`,
          },
        ),
      ),
    }
  }
  const admitted =
    input.cursor === undefined
      ? matching[0]
      : matching.find(({ number }) => number === input.cursor)
  if (!admitted) {
    return {
      kind: 'refuse',
      message: renderRefusal(
        refusal(
          `refusing keyed run turn because cursor ${input.cursor} is not an open workflow cursor held by harness session ${input.harnessSession} for project ${input.project} and task ${input.key}`,
          {
            kind: 'edit',
            text: `rerun with --cursor <number> naming one of: ${matching.map(({ number }) => number).join(', ')}`,
          },
        ),
      ),
    }
  }
  return {
    kind: 'allow',
    binding: { cursorRecordId: admitted.recordId, stepSlug: admitted.stepSlug },
  }
}

function decideBoundRootCursor(
  input: KeyedRunCursorAdmissionInput,
): KeyedRunCursorAdmission | null {
  if (!input.rootCursorRecordId) return null
  const heldRoot = input.heldCursors.find(({ recordId }) => recordId === input.rootCursorRecordId)
  if (!heldRoot) return { kind: 'allow' }
  return {
    kind: 'allow',
    binding: { cursorRecordId: heldRoot.recordId, stepSlug: heldRoot.stepSlug },
  }
}

function decideOverride(input: KeyedRunCursorAdmissionInput): KeyedRunCursorAdmission | null {
  if (!canOverride(input.turn) || input.overrideReason === undefined) return null
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

/** Apply cursor ownership and operator-override policy without reaching process or storage. */
export function decideKeyedRunCursorAdmission(
  input: KeyedRunCursorAdmissionInput,
): KeyedRunCursorAdmission {
  if (!input.key || (input.bindingPresent && !input.rootCursorRecordId)) {
    return { kind: 'allow' }
  }

  const boundRootDecision = input.cursor === undefined ? decideBoundRootCursor(input) : null
  if (boundRootDecision) return boundRootDecision

  const overrideDecision = decideOverride(input)
  if (overrideDecision) return overrideDecision

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

  const matching = input.heldCursors.filter(
    (cursor) => cursor.project === input.project && cursor.workflowKey === input.key,
  )
  if (matching.length) return decideMatchingCursor(input, matching)

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
    (input.bindingPresent && !input.rootCursorRecordId) ||
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
