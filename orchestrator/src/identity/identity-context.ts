// concern: record-identity
/** Adapts the existing session and caller project sources into one request identity context. */

import type { Database } from 'bun:sqlite'
import { storedMachineNames } from '../../../shared/machine-config.ts'
import { db } from '../database/db.ts'
import { sessionId } from '../database/session-identity.ts'
import { projectAt } from '../project/projects.ts'
import type { IdentityContext } from './identity.ts'

/** Reads each recorded session's owning project through the identity owner. */
export function sessionProjectRows(database: Database = db()) {
  return database
    .query<{ sessionId: string; project: string | null }, []>(
      'SELECT session_id AS sessionId,project FROM presence',
    )
    .all()
}

export function identityContext(
  database: Database,
  input: { session?: string | null; cwd?: string } = {},
): IdentityContext {
  const session = input.session === undefined ? sessionId(database) : input.session
  const present = session
    ? database
        .query<{ project: string | null; project_record_id: string | null }, [string]>(
          'SELECT project,project_record_id FROM presence WHERE session_id=?',
        )
        .get(session)
    : null
  const project = present?.project_record_id
    ? { recordId: present.project_record_id, name: present.project }
    : projectAt(input.cwd ?? process.cwd(), database)
  return {
    database,
    sessionId: session,
    projectId: project?.recordId ?? null,
    projectName: project?.name ?? null,
    machineNames: storedMachineNames(),
    identityMap: new Map(),
  }
}
