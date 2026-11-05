// concern: project-relink
/** Adopts a hosted project identity across the local project graph. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { RecordProject } from '../../../shared/record-project-contract.ts'
import { writableDb, writeTransaction } from '../database/db.ts'
import { retryOutboxRowsMatchingInWriteTransaction } from '../record/outbox-quarantine.ts'
import { stringifyOutboxPayload } from '../record/outbox-sanitize.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import { requireProjectRecordDestination } from '../record/record-project-destination-client.ts'
import { PROJECT_REFERENCES } from './project-reference-counts.ts'
import { retiredHostedProjectMessage } from './project-retired-hosted.ts'
import type { Project } from './projects.ts'
import { projectByName, projects } from './projects.ts'

export type ProjectRelinkResult = {
  name: string
  oldId: string
  newId: string
  status: 'relinked' | 'already-linked'
  rewritten: Record<string, number>
  retried: number
}

type ProjectAdoptionOutcome =
  | ProjectRelinkResult
  | { name: string; status: 'no-namesake' }
  | { name: string; status: 'retired-namesake'; message: string }

export type ProjectAdoptionResult =
  | ProjectAdoptionOutcome
  | { name: string; status: 'failed'; message: string }

const referenceColumns = (): Array<{ table: string; column: string }> => {
  const unique = new Map<string, { table: string; column: string }>()
  for (const [key, , column, explicitTable] of PROJECT_REFERENCES) {
    const table = explicitTable ?? key
    unique.set(`${table}.${column}`, { table, column })
  }
  return [...unique.values()]
}

function projectIdentityKey(key: string): boolean {
  const normalized = key.replaceAll(/[^a-z]/gi, '').toLowerCase()
  return normalized.endsWith('projectid') || normalized.endsWith('projectrecordid')
}

function rewritePayloadProjectIds(value: unknown, oldId: string, newId: string): boolean {
  if (Array.isArray(value))
    return value.reduce(
      (changed, item) => rewritePayloadProjectIds(item, oldId, newId) || changed,
      false,
    )
  if (!value || typeof value !== 'object') return false
  let changed = false
  for (const [key, item] of Object.entries(value)) {
    if (projectIdentityKey(key) && item === oldId) {
      ;(value as Record<string, unknown>)[key] = newId
      changed = true
    } else if (rewritePayloadProjectIds(item, oldId, newId)) {
      changed = true
    }
  }
  return changed
}

function rewritePendingOutbox(database: Database, oldId: string, newId: string): number {
  const rows = database
    .query<{ id: number; kind: string; payload: string }, []>(
      'SELECT id,kind,payload FROM outbox WHERE synced_at IS NULL',
    )
    .all()
  let rewritten = 0
  for (const row of rows) {
    let payload: unknown
    try {
      payload = JSON.parse(row.payload)
    } catch {
      continue
    }
    if (!rewritePayloadProjectIds(payload, oldId, newId)) continue
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue
    rewritten += database
      .query('UPDATE outbox SET payload=? WHERE id=? AND payload=? AND synced_at IS NULL')
      .run(
        stringifyOutboxPayload(row.kind, payload as Record<string, unknown>, {
          sanitizedForRules: true,
        }),
        row.id,
        row.payload,
      ).changes
  }
  return rewritten
}

/** Rewrite one project's identity and all registered local references atomically. */
export function relinkProjectIdentity(
  project: Pick<Project, 'name' | 'recordId'>,
  hostedId: string,
  database: Database = writableDb(),
): ProjectRelinkResult {
  if (project.recordId === hostedId) {
    return {
      name: project.name,
      oldId: project.recordId,
      newId: hostedId,
      status: 'already-linked',
      rewritten: {},
      retried: 0,
    }
  }
  const oldId = project.recordId
  let retried = 0
  const rewritten = writeTransaction(() => {
    database.exec('PRAGMA defer_foreign_keys = ON')
    const counts: Record<string, number> = {}
    for (const { table, column } of referenceColumns()) {
      const updateProjectReference = `UPDATE ${table} SET ${column}=? WHERE ${column}=?`
      const changes = database.query(updateProjectReference).run(hostedId, oldId).changes
      counts[table] = (counts[table] ?? 0) + changes
    }
    counts.project = database
      .query('UPDATE project SET record_id=? WHERE name=? AND record_id=?')
      .run(hostedId, project.name, oldId).changes
    if (counts.project !== 1)
      throw new Error(
        `project ${project.name} changed while it was being relinked; inspect \`${PLATFORM_SLUG} project list --json\` and retry`,
      )
    counts.outbox = rewritePendingOutbox(database, oldId, hostedId)
    retried = retryOutboxRowsMatchingInWriteTransaction(
      `record project ${oldId} is absent from request space `,
      database,
    )
    return counts
  }, database)
  return {
    name: project.name,
    oldId,
    newId: hostedId,
    status: 'relinked',
    rewritten,
    retried,
  }
}

export async function adoptHostedProjectIdentity(
  project: Project,
  database: Database = writableDb(),
): Promise<ProjectAdoptionOutcome> {
  const client = recordApiClient()
  const destinationSpaceId = await requireProjectRecordDestination(
    project.name,
    project.settings,
    client,
  )
  const hosted: RecordProject | undefined = (
    await client.listProjects({ destinationSpaceId })
  ).find((candidate) => candidate.name === project.name)
  if (!hosted) return { name: project.name, status: 'no-namesake' }
  if (project.recordId === hosted.id) return relinkProjectIdentity(project, hosted.id, database)
  if (hosted.retiredAt)
    return {
      name: project.name,
      status: 'retired-namesake',
      message: retiredHostedProjectMessage(project.name),
    }
  return relinkProjectIdentity(project, hosted.id, database)
}

export async function relinkProjectByName(
  name: string,
): Promise<ProjectRelinkResult | { name: string; status: 'no-namesake' }> {
  const project =
    projectByName(name) ?? projects({ retired: true }).find((row) => row.name === name)
  if (!project) throw new Error(`no project "${name}"`)
  const result = await adoptHostedProjectIdentity(project)
  if (result.status === 'retired-namesake') throw new Error(result.message)
  return result
}

export async function adoptAllHostedProjectIdentities(): Promise<ProjectAdoptionResult[]> {
  const localProjects = [...projects(), ...projects({ retired: true })]
  const adopted: ProjectAdoptionResult[] = []
  for (const project of localProjects) {
    try {
      adopted.push(await adoptHostedProjectIdentity(project))
    } catch (error) {
      adopted.push({
        name: project.name,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return adopted
}

export function formatProjectRelink(result: ProjectRelinkResult): string {
  if (result.status === 'already-linked')
    return `${result.name}: already linked to hosted project ${result.newId}`
  const counts = Object.entries(result.rewritten)
    .filter(([, count]) => count > 0)
    .map(([table, count]) => `${table}=${count}`)
    .join(', ')
  return `${result.name}: relinked ${result.oldId} -> ${result.newId}; ${counts || 'no rows rewritten'}; retried=${result.retried}`
}
