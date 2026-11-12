// concern: session start
/** Opens or reuses the calling session's keyless explore workflow. */

import type { Database } from 'bun:sqlite'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, sessionId } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import { resolveWorkflowLiveAutonomy } from '../workflow/workflow-cursor-live-autonomy.ts'
import { composeWorkflowWithCursor } from '../workflow/workflow-cursor.ts'
import { resolveWorkflowCursorContext } from '../workflow/workflow-cursor-selection.ts'
import { decideSessionStart } from './session-start-decision.ts'

export type SessionStartResult = {
  cursor: number | null
  line: string
}

type SessionStartDependencies = {
  database?: Database
  cwd?: string
  session?: string | null
}

const cursorLine = (cursor: number) => `cursor ${cursor} explore`

export async function startSession(
  dependencies: SessionStartDependencies = {},
): Promise<SessionStartResult> {
  const database = dependencies.database ?? db()
  const cwd = resolve(dependencies.cwd ?? process.cwd())
  const session = dependencies.session === undefined ? sessionId(database) : dependencies.session
  const project = projectAt(cwd, database)
  const openCursors = session
    ? await taskFlowReadStore(database).listOpenStages({ sessionId: session })
    : []
  const cursors = openCursors.map((cursor) => ({
          id: cursor.id,
          workflow: cursor.workflow_slug,
          state: cursor.state,
        }))
  const decision = decideSessionStart({ session, project: project?.name ?? null, cursors })
  if (decision.kind === 'refuse-session')
    return {
      cursor: null,
      line:
        `session start could not establish the current harness session id; cleared by: ` +
        `run ${PLATFORM_SLUG} session start from a supported harness SessionStart hook`,
    }
  if (decision.kind === 'refuse-project')
    return {
      cursor: null,
      line:
        `no registered project contains ${cwd}; cleared by: ${PLATFORM_SLUG} project add ${cwd}, ` +
        'or start the session in a registered checkout',
    }
  if (decision.kind === 'reuse')
    return { cursor: decision.cursor, line: cursorLine(decision.cursor) }

  const context = await resolveWorkflowCursorContext(project!.name, {}, { session })
  const live = await resolveWorkflowLiveAutonomy(
    { slug: 'explore', project: project!.name, mode: 'default', args: {}, context },
    database,
  )
  const composed = await composeWorkflowWithCursor(
    'explore',
    project!.name,
    'default',
    {},
    context,
    database,
    {},
    live,
  )
  if (!composed.cursor)
    throw new Error(
      `explore did not open a cursor; cleared by: ${PLATFORM_SLUG} workflow compose explore --project ${project!.name}`,
    )
  return { cursor: composed.cursor.id, line: cursorLine(composed.cursor.id) }
}

export async function safeStartSession(
  dependencies: SessionStartDependencies = {},
): Promise<SessionStartResult> {
  try {
    return await startSession(dependencies)
  } catch (error) {
    const condition = error instanceof Error ? error.message : String(error)
    return {
      cursor: null,
      line:
        `session start could not establish an explore cursor: ${condition}; cleared by: ` +
        `clear the reported condition and run ${PLATFORM_SLUG} session start again`,
    }
  }
}
