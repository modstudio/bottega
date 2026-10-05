import { expect, test } from 'bun:test'
import { decideProjectWrite } from './project-write-decision.ts'

test('project writes are hosted, local-authoritative, or refused from install facts', () => {
  expect(decideProjectWrite({ recordApiUrlSet: true, installBound: false })).toBe('hosted')
  expect(decideProjectWrite({ recordApiUrlSet: false, installBound: false })).toBe(
    'local-authoritative',
  )
  expect(decideProjectWrite({ recordApiUrlSet: false, installBound: true })).toBe('refused')
})
