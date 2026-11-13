// concern: session start
/** Opens or reuses the calling session's keyless explore workflow. */

import type { Database } from 'bun:sqlite'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { callerIdentityRefusal } from '../caller-classification.ts'
import { callerIdentity, db, sessionId } from '../database/db.ts'
import { projectAmong, projectAt, projects, retiredProjectRefusal } from '../project/projects.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import { composeWorkflowWithCursor } from '../workflow/workflow-cursor.ts'
import { resolveWorkflowLiveAutonomy } from '../workflow/workflow-cursor-live-autonomy.ts'
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

const cursorLine = (cursor: number, workflow = 'explore') => `cursor ${cursor} ${workflow}`
const remediedLine = (condition: string, remedy: string) =>
  renderRefusal(refusal(condition, { kind: 'edit', text: remedy })).replace(/\s+/g, ' ')

export async function startSession(
  dependencies: SessionStartDependencies = {},
): Promise<SessionStartResult> {
  const database = dependencies.database ?? db()
  const cwd = resolve(dependencies.cwd ?? process.cwd())
  const session = dependencies.session === undefined ? sessionId(database) : dependencies.session
  const project = projectAt(cwd, database)
  const openCursors = session
    ? await taskFlowReadStore(database).listOpenStages({
        project: project?.name,
        sessionId: session,
      })
    : []
  const cursors = openCursors.map((cursor) => ({
    id: cursor.id,
    workflow: cursor.workflow_slug,
  }))
  const decision = decideSessionStart({
    session,
    project: project?.name ?? null,
    openCursors: cursors,
  })
  if (decision.kind === 'refuse-session')
    return {
      cursor: null,
      line: `session start could not establish the current harness session id; ${callerIdentityRefusal(callerIdentity(database), 'start a session')}`,
    }
  if (decision.kind === 'refuse-project') {
    const retired = projectAmong(cwd, projects({ retired: true }, database))
    return {
      cursor: null,
      line: retired
        ? retiredProjectRefusal(retired.name)
        : remediedLine(
            `no registered project contains ${cwd}`,
            `${PLATFORM_SLUG} project add ${cwd}, or start the session in a registered checkout`,
          ),
    }
  }
  if (decision.kind === 'reuse')
    return { cursor: decision.cursor, line: cursorLine(decision.cursor, decision.workflow) }

  const context = { session }
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
  if (!composed.cursor) throw new Error('explore did not open a cursor')
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
      line: remediedLine(
        `session start could not establish an explore cursor: ${condition}`,
        `clear the reported condition and run ${PLATFORM_SLUG} session start again`,
      ),
    }
  }
}
