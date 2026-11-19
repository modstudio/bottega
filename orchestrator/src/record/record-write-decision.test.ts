import { expect, test } from 'bun:test'
import { decideRecordWrite } from './record-write-decision.ts'

const joinedLocalFacts = { machineJoined: true, localByDesign: false }

test('a joined machine refuses an unbound unconfigured store with both remedies', () => {
  const decision = decideRecordWrite({
    recordApiConfigured: false,
    installBound: false,
    boundOrigin: null,
    resolvedOrigin: 'https://api.example.test',
    ...joinedLocalFacts,
  })
  expect(decision).toMatchObject({ verdict: 'refused', boundOrigin: null })
  if (decision.verdict !== 'refused') throw new Error('expected a refusal')
  expect(decision.refusal).toContain('this machine has signed in to a hosted record')
  expect(decision.refusal).toContain('cleared by: unset BOTTEGA_ORCHESTRATOR_DB')
  expect(decision.refusal).toContain('cleared by: bottega record use <address>')
})

test('marked and never-joined unbound stores remain local-authoritative', () => {
  const input = {
    recordApiConfigured: false,
    installBound: false,
    boundOrigin: null,
    resolvedOrigin: 'https://api.example.test',
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
    }),
  ).toEqual({ verdict: 'local-authoritative' })
  const unknownOrigin = decideRecordWrite({
    recordApiConfigured: false,
    installBound: true,
    boundOrigin: null,
    resolvedOrigin,
    machineJoined: false,
    localByDesign: false,
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
