import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertProjectSpaceFunctionDeclaration } from './check-record-project-space-ownership.ts'

const MOVE_FUNCTION_MARKER = 'CREATE OR REPLACE FUNCTION record_move_project_space'

/** The newest migration redefining record_move_project_space, by directory name order. */
function moveFunctionMigration(): string {
  const folder = fileURLToPath(new URL('../shared/record/migrations', import.meta.url))
  const newest = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .filter((name) =>
      readFileSync(join(folder, name, 'migration.sql'), 'utf8').includes(MOVE_FUNCTION_MARKER),
    )
    .at(-1)
  if (newest === undefined) throw new Error(`no migration declares ${MOVE_FUNCTION_MARKER}`)
  return join(folder, newest, 'migration.sql')
}

const migration = readFileSync(moveFunctionMigration(), 'utf8')

test('project-space declaration gate rejects an added contradicting classification row', () => {
  const contradicting = migration.replace(
    "('hub_send','space'),",
    "('hub_send','space'),('hub_send','project'),",
  )
  expect(() => assertProjectSpaceFunctionDeclaration(contradicting)).toThrow(
    /classification mismatch:.*unexpected=.*hub_send.*project/,
  )
})

test('project-space declaration gate rejects a removed task-key traversal edge', () => {
  const removed = migration.replace(
    "    ('hub_interval','task_key',NULL,NULL,'project_id or project_name or hub_task.task_key'),\n",
    '',
  )
  expect(() => assertProjectSpaceFunctionDeclaration(removed)).toThrow(
    /ownership mismatch:.*missing=.*hub_interval.*task_key/,
  )
})

test('project-space declaration gate accepts the checked migration declaration', () => {
  expect(() => assertProjectSpaceFunctionDeclaration(migration)).not.toThrow()
})
