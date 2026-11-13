// concern: keyed run cursor admission
/** Decides whether a keyed run start is held by the calling harness session. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'

export type KeyedRunCursor = {
  project: string
  workflowKey: string
}

export type KeyedRunCursorAdmissionInput = {
  key: string | undefined
  project: string | null
  bindingPresent: boolean
  callerKind: 'harness' | 'operator' | 'worker' | 'no-identity'
  sessionId: string | null
  heldCursors: readonly KeyedRunCursor[]
  overrideReason: string | undefined
  fromOperator: boolean
}

export type KeyedRunCursorAdmission =
  | { kind: 'allow' }
  | { kind: 'allow-with-override'; warning: string }
  | { kind: 'refuse'; message: string }

const OVERRIDE_PREFIX = 'unbound keyed run start overridden by Shmuel Barkin: '

/** Apply cursor ownership and operator-override policy without reaching process or storage. */
export function decideKeyedRunCursorAdmission(
  input: KeyedRunCursorAdmissionInput,
): KeyedRunCursorAdmission {
  if (!input.key || input.bindingPresent || input.callerKind !== 'harness') {
    return { kind: 'allow' }
  }

  if (input.overrideReason !== undefined) {
    const reason = input.overrideReason.trim()
    if (!reason) {
      return { kind: 'refuse', message: '--override-unbound requires a non-empty reason' }
    }
    if (!input.fromOperator) {
      return {
        kind: 'refuse',
        message:
          'refusing unbound keyed run start override without operator attribution; rerun with ' +
          '--override-unbound "<reason>" --from-operator',
      }
    }
    return { kind: 'allow-with-override', warning: `${OVERRIDE_PREFIX}${reason}` }
  }

  if (
    input.project &&
    input.heldCursors.some(
      (cursor) => cursor.project === input.project && cursor.workflowKey === input.key,
    )
  ) {
    return { kind: 'allow' }
  }

  const project = input.project ?? '(no registered project)'
  return {
    kind: 'refuse',
    message:
      `refusing keyed run start because harness session ${input.sessionId ?? '(unknown)'} does not ` +
      `hold an open workflow cursor for project ${project} and task ${input.key}; cleared by: ` +
      `${PLATFORM_SLUG} workflow compose ship-task --project ${project} --arg key=${input.key}; ` +
      `${PLATFORM_SLUG} workflow list names the other workflows; override with ` +
      '--override-unbound "<reason>" --from-operator',
  }
}
