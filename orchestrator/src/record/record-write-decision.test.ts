import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideRecordWrite } from './record-write-decision.ts'

const joinedLocalFacts = {
  machineJoined: true,
  localByDesign: false,
  storePath: '/tmp/store.db',
  storeOverride: false,
}

test('a joined machine refuses an unbound unconfigured store with both remedies', () => {
  const decision = decideRecordWrite({
    recordApiConfigured: false,
    installBound: false,
    boundOrigin: null,
    resolvedOrigin: 'https://api.example.test',
    ...joinedLocalFacts,
    storeOverride: true,
  })
  expect(decision).toMatchObject({ verdict: 'refused', boundOrigin: null })
  if (decision.verdict !== 'refused') throw new Error('expected a refusal')
  expect(decision.refusal).toContain('this machine has signed in to a hosted record')
  expect(decision.refusal).toContain('cleared by: unset BOTTEGA_ORCHESTRATOR_DB')
  expect(decision.refusal).toContain(`cleared by: ${PLATFORM_SLUG} record use <address>`)
})

test('marked and never-joined unbound stores remain local-authoritative', () => {
  const input = {
    recordApiConfigured: false,
    installBound: false,
    boundOrigin: null,
    resolvedOrigin: 'https://api.example.test',
    storePath: '/tmp/store.db',
    storeOverride: false,
  }
  expect(decideRecordWrite({ ...input, machineJoined: true, localByDesign: true })).toEqual({
    verdict: 'local-authoritative',
  })
  expect(decideRecordWrite({ ...input, machineJoined: false, localByDesign: false })).toEqual({
    verdict: 'local-authoritative',
  })
})

test('shared-state writes are hosted, local-authoritative, or refused from install facts', () => {
  const resolvedOrigin = 'https://api.example.test'
  expect(
    decideRecordWrite({
      recordApiConfigured: true,
      installBound: false,
      boundOrigin: null,
      resolvedOrigin,
      ...joinedLocalFacts,
    }),
  ).toEqual({ verdict: 'hosted' })
  expect(
    decideRecordWrite({
      recordApiConfigured: true,
      installBound: true,
      boundOrigin: 'https://staging.example.test',
      resolvedOrigin,
      machineJoined: true,
      localByDesign: true,
      storePath: '/tmp/store.db',
      storeOverride: false,
    }),
  ).toEqual({ verdict: 'hosted' })
  expect(
    decideRecordWrite({
      recordApiConfigured: false,
      installBound: false,
      boundOrigin: null,
      resolvedOrigin,
      machineJoined: false,
      localByDesign: false,
      storePath: '/tmp/store.db',
      storeOverride: false,
    }),
  ).toEqual({ verdict: 'local-authoritative' })
  const unknownOrigin = decideRecordWrite({
    recordApiConfigured: false,
    installBound: true,
    boundOrigin: null,
    resolvedOrigin,
    machineJoined: false,
    localByDesign: false,
    storePath: '/tmp/store.db',
    storeOverride: false,
  })
  expect(unknownOrigin).toMatchObject({
    verdict: 'refused',
    boundOrigin: null,
    resolvedOrigin,
  })
  if (unknownOrigin.verdict !== 'refused') throw new Error('expected a refusal')
  expect(unknownOrigin.refusal).toContain('no recorded address')
  expect(unknownOrigin.refusal).toContain('record use <address>')
  expect(unknownOrigin.refusal).not.toContain('sign in')
  expect(
    decideRecordWrite({
      recordApiConfigured: false,
      installBound: true,
      boundOrigin: resolvedOrigin,
      resolvedOrigin,
      ...joinedLocalFacts,
    }),
  ).toEqual({ verdict: 'hosted' })
  expect(
    decideRecordWrite({
      recordApiConfigured: false,
      installBound: true,
      boundOrigin: 'https://staging.example.test',
      resolvedOrigin,
      ...joinedLocalFacts,
    }),
  ).toMatchObject({
    verdict: 'refused',
    boundOrigin: 'https://staging.example.test',
    resolvedOrigin,
    refusal: expect.stringContaining('record use https://staging.example.test'),
  })
})

test('a joined store without an override names only record use', () => {
  const decision = decideRecordWrite({
    recordApiConfigured: false,
    installBound: false,
    boundOrigin: null,
    resolvedOrigin: 'https://api.example.test',
    ...joinedLocalFacts,
  })
  if (decision.verdict !== 'refused') throw new Error('expected a refusal')
  expect(decision.refusal).not.toContain('unset BOTTEGA_ORCHESTRATOR_DB')
  expect(decision.refusal).toContain(`cleared by: ${PLATFORM_SLUG} record use <address>`)
})

test('an unreadable session stamp refuses an unbound unconfigured store', () => {
  const decision = decideRecordWrite({
    recordApiConfigured: false,
    installBound: false,
    boundOrigin: null,
    resolvedOrigin: 'https://api.example.test',
    machineJoined: 'unreadable',
    localByDesign: false,
    storePath: '/tmp/store.db',
    storeOverride: false,
  })
  expect(decision).toMatchObject({ verdict: 'refused', boundOrigin: null })
  if (decision.verdict !== 'refused') throw new Error('expected a refusal')
  expect(decision.refusal).toContain('record session stamp is unreadable')
  expect(decision.refusal).toContain(`cleared by: ${PLATFORM_SLUG} record use <address>`)
})

test('discard-store classification is platform-specific', () => {
  const input = {
    recordApiConfigured: false,
    installBound: false,
    boundOrigin: null,
    resolvedOrigin: 'https://api.example.test',
    ...joinedLocalFacts,
  }
  expect(decideRecordWrite({ ...input, storePath: '/dev/null' })).toEqual({
    verdict: 'local-authoritative',
  })
  expect(decideRecordWrite({ ...input, storePath: 'nul' })).toMatchObject({ verdict: 'refused' })
})
