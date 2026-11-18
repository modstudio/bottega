import { expect, test } from 'bun:test'
import { resolveWorkflowCursorSuccessor } from './workflow-cursor-successor.ts'

test('resolves an evidence cursor through every handoff successor', () => {
  expect(
    resolveWorkflowCursorSuccessor('source', [
      { record_id: 'middle', handed_off_from_record_id: 'source' },
      { record_id: 'open', handed_off_from_record_id: 'middle' },
    ]),
  ).toBe('open')
})
