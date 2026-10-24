import { expect, test } from 'bun:test'
import { replicatedRecordId } from './record-id.ts'

test('replicated record ids are stable for a known input', () => {
  expect(replicatedRecordId('space-a', 'workflow', 'source-a')).toBe(
    '7b641400-2aff-50da-8798-ef23b8989aa7',
  )
})
