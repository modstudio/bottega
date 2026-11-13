// concern: keyed run cursor admission
/** Decides whether a keyed run start is held by the calling harness session. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'

type KeyedRunCursor = {
  project: string
  workflowKey: string
}

export type KeyedRunCursorAdmissionInput = {
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
const OVERRIDE_PREFIX = 'unbound keyed run start overridden by Shmuel Barkin: '

/** Apply cursor ownership and operator-override policy without reaching process or storage. */
export function decideKeyedRunCursorAdmission(
  input: KeyedRunCursorAdmissionInput,
): KeyedRunCursorAdmission {
  if (!input.key || input.bindingPresent || !input.harnessSession) {
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
          'refusing unbound keyed run start override without operator attribution; rerun with ' +
          OVERRIDE_REMEDY,
      }
    }
    return { kind: 'allow-with-override', warning: `${OVERRIDE_PREFIX}${reason}` }
  }

  if (!input.project) {
    return {
      kind: 'refuse',
      message: renderRefusal(
        refusal(
          `refusing keyed run start because the dispatch location is outside every registered project, so cursor ownership for harness session ${input.harnessSession} and task ${input.key} cannot be established`,
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
        `refusing keyed run start because harness session ${input.harnessSession} does not ` +
          `hold an open workflow cursor for project ${input.project} and task ${input.key}`,
        {
          kind: 'edit',
          text:
            `${PLATFORM_SLUG} workflow compose ship-task --project ${input.project} --arg key=${input.key}; ` +
            `${PLATFORM_SLUG} workflow list names the other workflows; override with ` +
            OVERRIDE_REMEDY,
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
          `refusing keyed run start because open workflow cursors for harness session ${input.harnessSession} could not be read: ${reason}`,
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
