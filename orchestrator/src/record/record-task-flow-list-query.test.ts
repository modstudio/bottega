import { expect, test } from 'bun:test'
import { taskFlowStageListQuerySchema } from './record-task-flow-contract.ts'
import { taskFlowStageListSql } from './record-task-flow-list-query.ts'

test('stage-list SQL applies linked-task and opening-machine filters', () => {
  const input = taskFlowStageListQuerySchema.parse({
    linked: 'true',
    openedMachineId: '00000000-0000-4000-8000-000000000001',
  })
  const query = taskFlowStageListSql('00000000-0000-4000-8000-000000000002', input)
  expect(query.clauses).toContain('f.task_id IS NOT NULL')
  expect(query.clauses).toContain('s.opened_machine_id=$2::uuid')
  expect(query.values).toEqual([
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
  ])
})
