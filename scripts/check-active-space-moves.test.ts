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

test('refuses every form that can take or alias the active-space member', () => {
  const findings = activeSpaceWriteCalls({
    'orchestrator/src/unsafe.ts': `
      function bracket() { client['setActiveOrganization']({ organizationId: id }) }
      function alias() { const f = client.setActiveOrganization; f({ organizationId: id }) }
      function destructure() { const { setActiveOrganization: move } = client; move({ organizationId: id }) }
      function reference() { consume(client.setActiveOrganization) }
    `,
  })

  expect(findings.map(({ functionName }) => functionName)).toEqual([
    'bracket',
    'alias',
    'destructure',
    'reference',
  ])
  expect(activeSpaceWriteViolations(findings)).toHaveLength(4)
})
