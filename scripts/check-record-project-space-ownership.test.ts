import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assertProjectSpaceFunctionDeclaration } from './check-record-project-space-ownership.ts'

const migration = readFileSync(
  fileURLToPath(
    new URL(
      '../shared/record/migrations/20261020020004_dev_1214_declared_project_move/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

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
