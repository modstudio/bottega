// concern: local-project-purge
/** Purges the hub rows owned by one registered project. */
import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import type { RemovalReport } from '../../shared/removal-report.ts'
import { writeTransaction } from './db.ts'
import { type ProjectRecordIdSource, projectRecordIdFor } from './project-record-id.ts'
import { everyRegisteredProject } from './projects.ts'

export function resolvePurgeRecordId(
  projectName: string,
  registered: readonly ProjectRecordIdSource[] = everyRegisteredProject(),
): string {
  const recordId = projectRecordIdFor(projectName, registered)
  if (!recordId)
    throw new Error(
      `project ${projectName} is not in this machine's register; run \`${PLATFORM_SLUG} project list\` and \`${PLATFORM_SLUG} project list --retired\` to inspect the register`,
    )
  return recordId
}

const LOCAL_PROJECT_PURGE_EXCLUSIONS = {
  send: 'send.projects is an historical text list, not project-owned rows',
  task_identity_migration_repairs:
    'task_identity_migration_repairs.projects is an audit text list, not project-owned rows',
} as const

const LOCAL_PROJECT_PURGE_PLAN = [
  {
    table: 'task_comment',
    predicate:
      'task_record_id IN (SELECT record_id FROM task WHERE project_record_id=?1 OR (project_record_id IS NULL AND project=?2))',
  },
  {
    table: 'task_document',
    predicate:
      'task_record_id IN (SELECT record_id FROM task WHERE project_record_id=?1 OR (project_record_id IS NULL AND project=?2))',
  },
  {
    table: 'task_status_event',
    predicate:
      'task_record_id IN (SELECT record_id FROM task WHERE project_record_id=?1 OR (project_record_id IS NULL AND project=?2))',
  },
  {
    table: 'task',
    predicate: 'project_record_id=?1 OR (project_record_id IS NULL AND project=?2)',
  },
  {
    table: 'note_acknowledgement',
    predicate:
      'note_record_id IN (SELECT record_id FROM note WHERE project_record_id=?1 OR (project_record_id IS NULL AND project=?2))',
  },
  {
    table: 'note',
    predicate: 'project_record_id=?1 OR (project_record_id IS NULL AND project=?2)',
  },
  {
    table: 'note_counter',
    predicate: 'project_record_id=?1 OR (project_record_id IS NULL AND project=?2)',
  },
  {
    table: 'interval',
    predicate: 'project_record_id=?1 OR (project_record_id IS NULL AND project=?2)',
  },
  {
    table: 'question',
    predicate: 'project_record_id=?1 OR (project_record_id IS NULL AND project=?2)',
  },
  {
    table: 'task_identity_claim',
    predicate: 'project_record_id=?1 OR (project_record_id IS NULL AND project=?2)',
  },
  { table: 'hosted_outbox', predicate: 'routing_project_record_id=?1' },
] as const

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

export function uncoveredHubProjectTables(database: Database): string[] {
  const covered = new Set<string>(LOCAL_PROJECT_PURGE_PLAN.map((step) => step.table))
  const excluded = new Set(Object.keys(LOCAL_PROJECT_PURGE_EXCLUSIONS))
  return database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .filter(({ name }) => {
      const columns = database
        .query(`PRAGMA table_info(${quote(name)})`)
        .all()
        .map((row) => String((row as Record<string, unknown>).name))
      const carriesProject = columns.some(
        (column) =>
          column === 'project' ||
          column === 'project_record_id' ||
          column.endsWith('_project_record_id'),
      )
      return carriesProject && !covered.has(name) && !excluded.has(name)
    })
    .map(({ name }) => name)
}

export function purgeHubProject(
  database: Database,
  projectRecordId: string,
  projectName: string,
): RemovalReport {
  const uncovered = uncoveredHubProjectTables(database)
  if (uncovered.length)
    throw new Error(`project purge plan does not cover hub table(s): ${uncovered.join(', ')}`)
  return writeTransaction(
    (conn) =>
      LOCAL_PROJECT_PURGE_PLAN.map((step) => ({
        table: step.table,
        count: step.predicate.includes('?2')
          ? conn
              .query(`DELETE FROM ${quote(step.table)} WHERE ${step.predicate}`)
              .run(projectRecordId, projectName).changes
          : conn
              .query(`DELETE FROM ${quote(step.table)} WHERE ${step.predicate}`)
              .run(projectRecordId).changes,
      })),
    database,
  )
}
