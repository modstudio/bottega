import { expect, test } from 'bun:test'
import {
  activeSpaceSourceViolations,
  activeSpaceWriteCalls,
  activeSpaceWriteViolations,
} from './check-active-space-moves.ts'

test('production source has no unverified active-space write', () => {
  expect(activeSpaceSourceViolations()).toEqual([])
})

test('refuses active-space writes outside the verifier and named server or web paths', () => {
  const findings = activeSpaceWriteCalls({
    'orchestrator/src/record/record-space.ts':
      'function setAndVerifyActiveRecordSpace() { client.setActiveOrganization({ organizationId }) }',
    'hub/web/src/routes/accept-invitation.$id.tsx':
      'const act = async () => { await setActiveOrganization(id) }',
    'orchestrator/src/unsafe.ts':
      'function moveActiveSpace() { client.setActiveOrganization({ organizationId: id }) }',
    'hub/src/unsafe.ts': 'const moveActiveSpace = () => setActiveOrganization(id)',
  })

  expect(activeSpaceWriteViolations(findings)).toEqual([
    'hub/src/unsafe.ts:1: setActiveOrganization bypasses setAndVerifyActiveRecordSpace in orchestrator/src/record/record-space.ts',
    'orchestrator/src/unsafe.ts:1: setActiveOrganization bypasses setAndVerifyActiveRecordSpace in orchestrator/src/record/record-space.ts',
  ])
})

test('does not exempt another function in an admitted file', () => {
  const findings = activeSpaceWriteCalls({
    'hub/web/src/routes/accept-invitation.$id.tsx':
      'function hiddenWrite() { setActiveOrganization(id) }',
  })
  expect(activeSpaceWriteViolations(findings)).toHaveLength(1)
})
