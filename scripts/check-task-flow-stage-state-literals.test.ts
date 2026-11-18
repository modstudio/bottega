import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskFlowStageStateLiteralRestatements } from './check-task-flow-stage-state-literals.ts'

test('rejects task-flow stage-state sets but not individual value expressions', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-flow-stage-state-guard-'))
  const source = join(root, 'orchestrator/src/workflow')
  mkdirSync(source, { recursive: true })
  writeFileSync(
    join(source, 'filter.ts'),
    [
      "const open = ['running', 'awaiting-ruling']",
      "const query = `SELECT 1 WHERE state NOT IN ('done','abandoned')`",
      "const closed = state === 'done' || state === 'abandoned'",
      "type ClosedState = 'done' | 'abandoned'",
      "expect(closedTaskAnnotation('running', 'done')).toBe('CLOSED TASK done')",
      "const state = result === 'next' ? 'running' : 'awaiting-ruling'",
    ].join('\n'),
  )

  expect(taskFlowStageStateLiteralRestatements(root)).toEqual([
    'orchestrator/src/workflow/filter.ts:1: derive task-flow stage-state sets from record-task-flow-contract',
    'orchestrator/src/workflow/filter.ts:2: derive task-flow stage-state sets from record-task-flow-contract',
    'orchestrator/src/workflow/filter.ts:3: derive task-flow stage-state sets from record-task-flow-contract',
    'orchestrator/src/workflow/filter.ts:4: derive task-flow stage-state sets from record-task-flow-contract',
  ])
})

test('ignores same-word vocabularies outside stage context but catches SQL state predicates', () => {
  const root = mkdtempSync(join(tmpdir(), 'task-flow-stage-state-guard-'))
  const run = join(root, 'orchestrator/src/run')
  mkdirSync(run, { recursive: true })
  writeFileSync(join(run, 'status.ts'), "type Status = 'running' | 'abandoned'\n")
  writeFileSync(
    join(run, 'query.ts'),
    "const query = `SELECT 1 WHERE state IN ('running','awaiting-ruling')`\n",
  )

  expect(taskFlowStageStateLiteralRestatements(root)).toEqual([
    'orchestrator/src/run/query.ts:1: derive task-flow stage-state sets from record-task-flow-contract',
  ])
})
