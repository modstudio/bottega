import { expect, test } from 'bun:test'
import {
  identityReferenceGuardViolations,
  identityReferenceViolationCount,
} from './architecture-identity-reference.ts'

test('identity reference guard rejects a new number-column lookup outside identity', () => {
  const added = identityReferenceViolationCount('SELECT record_id FROM run WHERE number=?')
  expect(identityReferenceGuardViolations({ 'orchestrator/src/run/new.ts': added }, {})).toEqual([
    'orchestrator/src/run/new.ts: production identity bypass count grew from 0 to 1; resolve the reference through identity/',
  ])
})
