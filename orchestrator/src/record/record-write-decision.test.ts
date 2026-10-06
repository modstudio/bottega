import { expect, test } from 'bun:test'
import { decideRecordWrite } from './record-write-decision.ts'

test('shared-state writes are hosted, local-authoritative, or refused from install facts', () => {
  expect(decideRecordWrite({ recordApiUrlSet: true, installBound: false })).toBe('hosted')
  expect(decideRecordWrite({ recordApiUrlSet: false, installBound: false })).toBe(
    'local-authoritative',
  )
  expect(decideRecordWrite({ recordApiUrlSet: false, installBound: true })).toBe('refused')
})
