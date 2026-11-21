import { expect, test } from 'bun:test'
import { taskFlowStageListQuerySchema } from './record-task-flow-contract.ts'
import { taskFlowStageListSql } from './record-task-flow-list-query.ts'

test('workflowKeys combines with existing stage-list predicates by AND', () => {
  const input = taskFlowStageListQuerySchema.parse({
    projectId: '00000000-0000-4000-8000-000000000001',
    states: ['running'],
    workflowKeys: ['DEV-1', 'DEV-2'],
  })
  const query = taskFlowStageListSql('00000000-0000-4000-8000-000000000002', input)
  expect(query.clauses).toEqual([
    's.space_id=$1::uuid',
    's.project_id=$2::uuid',
    's.state IN ($3)',
    's.workflow_key=ANY($4::text[])',
  ])
  expect(query.values).toEqual([
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    'running',
    ['DEV-1', 'DEV-2'],
  ])
})
