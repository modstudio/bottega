// concern: project-record-identity
/** Fills the one sanctioned project-name match from the hosted record. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { authenticatedRecordApiClient, recordApiClient } from '../record/record-api-client.ts'
import { requireProjectRecordDestination } from '../record/record-project-destination-client.ts'
import { storedRecordToken, storedRecordTokenAsync } from '../record/record-session.ts'
import {
  BOUND_RECORD_WRITE_REFUSAL,
  currentRecordWriteDecision,
} from '../record/record-write-authority.ts'
import type { StoredProjectSettings } from './project-settings.ts'
import { storeProjectRecordId } from './projects.ts'

export type FilledProjectRecordId = {
  name: string
  recordId: string
  source: 'hosted' | 'created' | 'local'
}

export type ProjectRecordIdDecision =
  | { kind: 'already-filled' }
  | { kind: 'use-hosted'; recordId: string }
  | { kind: 'create-hosted' }
  | { kind: 'mint-local' }

type MissingProjectRecordRow = {
  id: number
  record_id: null
  name: string
  path: string
  stack: string | null
  canon: number
  settings: string | null
  retired_at: string | null
}

type MissingProject = {
  id: number
  recordId: null
  name: string
  path: string
  stack: string | null
  canon: boolean
  settings: StoredProjectSettings
  retiredAt: string | null
}

/** Decide identity provenance without performing either hosted or local I/O. */
export function decideProjectRecordId(input: {
  recordId: string | null
  hostedRecordId: string | null
  retired: boolean
  hostingConfigured: boolean
}): ProjectRecordIdDecision {
  if (input.recordId) return { kind: 'already-filled' }
  if (!input.hostingConfigured) return { kind: 'mint-local' }
  if (input.hostedRecordId) return { kind: 'use-hosted', recordId: input.hostedRecordId }
  if (input.retired) return { kind: 'mint-local' }
  return { kind: 'create-hosted' }
}

function parseMissingProject(row: MissingProjectRecordRow): MissingProject {
  let settings: StoredProjectSettings = {}
  try {
    settings = row.settings ? JSON.parse(row.settings) : {}
  } catch {
    settings = {}
  }
  return {
    id: row.id,
    recordId: null,
    name: row.name,
    path: row.path,
    stack: row.stack,
    canon: row.canon === 1,
    settings,
    retiredAt: row.retired_at,
  }
}

async function hostedProjectIdentity(
  project: MissingProject,
  client: ReturnType<typeof recordApiClient>,
): Promise<Omit<FilledProjectRecordId, 'name'>> {
  const destination = {
    destinationSpaceId: await requireProjectRecordDestination(
      project.name,
      project.settings,
      client,
    ),
  }
  const hosted = (await client.listProjects(destination)).find(
    (candidate) => candidate.name === project.name,
  )
  const decision = decideProjectRecordId({
    recordId: null,
    hostedRecordId: hosted?.id ?? null,
    retired: Boolean(project.retiredAt),
    hostingConfigured: true,
  })
  if (decision.kind === 'use-hosted') return { recordId: decision.recordId, source: 'hosted' }
  if (decision.kind === 'mint-local') return { recordId: newRecordId(), source: 'local' }
  const result = await client.upsertProject(
    {
      id: newRecordId(),
      name: project.name,
      path: project.path,
      stack: project.stack,
      canon: project.canon,
      settings: project.settings,
      retiredAt: project.retiredAt,
    },
    destination,
  )
  return { recordId: result.id, source: 'created' }
}

/** Fill only missing identities; existing local identities are never name-matched again. */
export async function fillProjectRecordIds(database?: Database): Promise<FilledProjectRecordId[]> {
  const store = database ?? (await import('../database/db.ts')).writableDb()
  const hasIntegerId = (
    store.query("SELECT COUNT(*) AS n FROM pragma_table_info('project') WHERE name='id'").get() as {
      n: number
    }
  ).n
  // The UUID-keyed project table makes a missing identity structurally impossible.
  if (hasIntegerId === 0) return []

  const rows = store
    .query(
      `SELECT id,record_id,name,path,stack,canon,settings,retired_at
       FROM project WHERE record_id IS NULL ORDER BY name`,
    )
    .all() as MissingProjectRecordRow[]
  if (rows.length === 0) return []
  const authority = currentRecordWriteDecision(database)
  if (authority === 'refused') throw new Error(BOUND_RECORD_WRITE_REFUSAL)
  const hostingConfigured = authority === 'hosted'
  const client = hostingConfigured
    ? database
      ? authenticatedRecordApiClient({
          token: () => storedRecordToken(database),
          tokenAsync: (signal) => storedRecordTokenAsync(database, signal),
        })
      : recordApiClient()
    : null
  const filled: FilledProjectRecordId[] = []
  for (const row of rows) {
    const project = parseMissingProject(row)
    const localDecision = decideProjectRecordId({
      recordId: null,
      hostedRecordId: null,
      retired: Boolean(project.retiredAt),
      hostingConfigured,
    })
    if (localDecision.kind === 'mint-local') {
      const recordId = newRecordId()
      storeProjectRecordId(project.name, recordId, database)
      filled.push({ name: project.name, recordId, source: 'local' })
      continue
    }
    const { recordId, source } = await hostedProjectIdentity(project, client!)
    storeProjectRecordId(project.name, recordId, database)
    filled.push({ name: project.name, recordId, source })
  }
  return filled
}
