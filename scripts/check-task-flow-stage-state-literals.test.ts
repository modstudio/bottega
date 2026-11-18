import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskFlowStageStateLiteralRestatements } from './check-task-flow-stage-state-literals.ts'

test('rejects a line that restates a task-flow stage-state set', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-flow-stage-state-guard-'))
  const source = join(root, 'orchestrator/src/example')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'filter.ts'), "const open = ['running', 'awaiting-ruling']\n")

  expect(taskFlowStageStateLiteralRestatements(root)).toEqual([
    'orchestrator/src/example/filter.ts:1: derive task-flow stage-state sets from record-task-flow-contract',
  ])
})

test('admits the declaration, immutable migrations, and hosted partial index only', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-flow-stage-state-guard-'))
  const declaration = join(root, 'orchestrator/src/record')
  const migrations = join(root, 'shared/record/migrations/0001_fixture')
  const shared = join(root, 'shared/record')
  mkdirSync(declaration, { recursive: true })
  mkdirSync(migrations, { recursive: true })
  writeFileSync(
    join(declaration, 'record-task-flow-contract.ts'),
    "export const states = ['running', 'awaiting-ruling', 'done', 'abandoned']\n",
  )
  writeFileSync(join(migrations, 'migration.sql'), "state IN ('running','awaiting-ruling')\n")
  writeFileSync(
    join(shared, 'schema-task-flow.ts'),
    `      .where(sql\`\${table.state} NOT IN ('done','abandoned')\`),\n`,
  )

  expect(taskFlowStageStateLiteralRestatements(root)).toEqual([])
})
