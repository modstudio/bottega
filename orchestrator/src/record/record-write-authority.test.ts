import { expect, test } from 'bun:test'
import { decideRecordWrite } from './record-write-decision.ts'

test('an unbound install without an explicit record address remains local-authoritative', () => {
  expect(decideRecordWrite({ recordApiUrlSet: false, installBound: false })).toBe(
    'local-authoritative',
  )
})
