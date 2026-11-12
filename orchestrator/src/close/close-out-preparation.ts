// concern: asynchronous close-out preparation
/** Captures inputs needed by synchronous close-out coordination. */

import { openCursorWorktrees } from '../workflow/workflow-cursor-worktrees.ts'

export type CloseOutPreparation = {
  cursorWorktrees: Awaited<ReturnType<typeof openCursorWorktrees>>
}

export async function prepareCloseOut(): Promise<CloseOutPreparation> {
  return { cursorWorktrees: await openCursorWorktrees() }
}
