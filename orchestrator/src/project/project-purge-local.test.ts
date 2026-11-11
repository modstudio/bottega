import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  orchestratorProjectPurgePlan,
  uncoveredOrchestratorProjectTables,
} from './project-purge-local.ts'

test('the live orchestrator schema has no uncovered project-bearing table', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  expect(uncoveredOrchestratorProjectTables(database)).toEqual([])
  const tables = orchestratorProjectPurgePlan(database).map(({ table }) => table)
  for (const table of [
    'run',
    'score',
    'question',
    'run_message',
    'review_finding',
    'port_pair',
    'port_ref',
    'port_ref_source',
    'project_lens_profile',
    'outbox',
  ])
    expect(tables).toContain(table)
  database.close()
})
