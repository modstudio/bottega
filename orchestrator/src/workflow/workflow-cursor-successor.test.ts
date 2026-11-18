import { expect, test } from 'bun:test'
import { taskFlowHandoffLinks, type TaskFlowReadStore } from './task-flow-store.ts'
import { resolveWorkflowCursorSuccessor } from './workflow-run-binding.ts'

test('resolves an evidence cursor through every handoff successor', () => {
  expect(
    resolveWorkflowCursorSuccessor('source', [
      { record_id: 'middle', handed_off_from_record_id: 'source' },
      { record_id: 'open', handed_off_from_record_id: 'middle' },
    ]),
  ).toBe('open')
})

test('reads a multi-handoff lineage from authoritative closed stage rows', async () => {
  const rows = new Map([
    ['source', { record_id: 'source', handed_off_from_record_id: null }],
    ['middle', { record_id: 'middle', handed_off_from_record_id: 'source' }],
    ['current', { record_id: 'current', handed_off_from_record_id: 'middle' }],
  ])
  const store = {
    stageByRecordId: async (recordId: string) => rows.get(recordId) ?? null,
  } as TaskFlowReadStore

  const links = await taskFlowHandoffLinks(store, ['current'])

  expect(resolveWorkflowCursorSuccessor('source', links)).toBe('current')
  expect(links).toEqual([
    { record_id: 'current', handed_off_from_record_id: 'middle' },
    { record_id: 'middle', handed_off_from_record_id: 'source' },
    { record_id: 'source', handed_off_from_record_id: null },
  ])
})
