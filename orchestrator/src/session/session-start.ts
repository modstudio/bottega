// concern: session start
/** Opens or reuses the calling session's keyless explore workflow. */

import type { Database } from 'bun:sqlite'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { callerIdentityRefusal } from '../caller-classification.ts'
import { callerIdentity, db, sessionId } from '../database/db.ts'
import { publishHarnessSession } from '../harness-session/harness-session.ts'
import { projectAt, retiredProjectAt, retiredProjectRefusal } from '../project/projects.ts'
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
  harnessPid?: number
  source?: string
  observeHarnessStartTime?: (pid: number) => string | null
}

const cursorLine = (cursor: number, workflow = 'explore') => `cursor ${cursor} ${workflow}`
const remediedLine = (condition: string, remedy: string) =>
  renderRefusal(refusal(condition, { kind: 'edit', text: remedy })).replace(/\s+/g, ' ')

function publishHarnessSessionFailure(
  dependencies: SessionStartDependencies,
  session: string | null,
): string | null {
  if (!session || dependencies.harnessPid === undefined) return null
  try {
    publishHarnessSession({
      pid: dependencies.harnessPid,
      session,
      source: dependencies.source ?? 'startup',
      observeStartTime: dependencies.observeHarnessStartTime,
    })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export async function startSession(
  dependencies: SessionStartDependencies = {},
): Promise<SessionStartResult> {
  const database = dependencies.database ?? db()
  const session = dependencies.session === undefined ? sessionId(database) : dependencies.session
  const publicationFailure = publishHarnessSessionFailure(dependencies, session)
  const withPublicationFailure = (result: SessionStartResult): SessionStartResult =>
    publicationFailure
      ? {
          ...result,
          line: `${result.line}; ${remediedLine(
            `harness session publication failed: ${publicationFailure}`,
            'start a new Claude session or run /clear',
          )}`,
        }
      : result
  const cwd = resolve(dependencies.cwd ?? process.cwd())
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
    workflowKey: cursor.workflow_key,
  }))
  const decision = decideSessionStart({
    session,
    project: project?.name ?? null,
    openCursors: cursors,
  })
  if (decision.kind === 'refuse-session')
    return withPublicationFailure({
      cursor: null,
      line: `session start could not establish the current harness session id; ${callerIdentityRefusal(callerIdentity(database), 'start a session')}`,
    })
  if (decision.kind === 'refuse-project') {
    const retired = retiredProjectAt(cwd, database)
    return withPublicationFailure({
      cursor: null,
      line: retired
        ? retiredProjectRefusal(retired.name)
        : remediedLine(
            `no registered project contains ${cwd}`,
            `${PLATFORM_SLUG} project add ${cwd}, or start the session in a registered checkout`,
          ),
    })
  }
  if (decision.kind === 'reuse')
    return withPublicationFailure({
      cursor: decision.cursor,
      line: cursorLine(decision.cursor, decision.workflow),
    })
  if (decision.kind === 'none')
    return withPublicationFailure({
      cursor: null,
      line: `${cursorLine(decision.cursor, decision.workflow)} ${decision.key} is open; session start composed no explore cursor`,
    })

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
  if (!composed.cursor)
    return withPublicationFailure({
      cursor: null,
      line: remediedLine(
        `project ${project!.name} has no explore default mode that opens without arguments in its workflow catalogue`,
        `${PLATFORM_SLUG} workflow import a workflow tree that defines explore, then run ${PLATFORM_SLUG} session start again`,
      ),
    })
  return withPublicationFailure({
    cursor: composed.cursor.id,
    line: cursorLine(composed.cursor.id),
  })
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
