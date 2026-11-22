import { expect, test } from 'bun:test'
import {
  contractRoutesFromSource,
  currentHostedSecretRouteDrift,
  hostedSecretRouteDrift,
  mergeRecordRouteBaseline,
  staleRecordRouteBaseline,
  undeclaredRecordRoutes,
} from './check-record-route-contracts.ts'

test('hosted secret route guard fails closed in both directions', () => {
  expect(hostedSecretRouteDrift(['POST /one', 'PUT /two'], ['POST /one'])).toEqual({
    missing: ['PUT /two'],
    stale: [],
  })
  expect(hostedSecretRouteDrift(['POST /one'], ['POST /one', 'PATCH /old'])).toEqual({
    missing: [],
    stale: ['PATCH /old'],
  })
})

test('both deployed write route registries have a secret-policy entry', () => {
  expect(currentHostedSecretRouteDrift()).toEqual({ missing: [], stale: [] })
})

test('an undeclared new record route is refused', () => {
  expect(
    undeclaredRecordRoutes(
      ['GET /v1/covered', 'POST /v1/baselined', 'PUT /v1/new'],
      new Set(['GET /v1/covered']),
      [{ route: 'POST /v1/baselined', reason: 'untested' }],
    ),
  ).toEqual(['PUT /v1/new'])
})

test('a contracted baseline entry is stale', () => {
  expect(
    staleRecordRouteBaseline(['GET /v1/covered'], new Set(['GET /v1/covered']), [
      { route: 'GET /v1/covered', reason: 'untested' },
    ]),
  ).toEqual(['GET /v1/covered'])
})

test('a vanished baseline route is stale', () => {
  expect(
    staleRecordRouteBaseline(['GET /v1/registered'], new Set(), [
      { route: 'GET /v1/vanished', reason: 'untested' },
    ]),
  ).toEqual(['GET /v1/vanished'])
})

test('baseline update preserves an existing unsupported reason', () => {
  expect(
    mergeRecordRouteBaseline(['GET /v1/existing', 'POST /v1/new'], new Set(), [
      { route: 'GET /v1/existing', reason: 'unsupported:stream' },
    ]),
  ).toEqual([
    { route: 'GET /v1/existing', reason: 'unsupported:stream' },
    { route: 'POST /v1/new', reason: 'untested' },
  ])
})

test('a contractRoutes mention without a parseable declaration is refused', () => {
  expect(() =>
    contractRoutesFromSource(
      'orchestrator/src/record/broken-contract.test.ts',
      "const contractRoutes = ['GET /v1/broken']",
    ),
  ).toThrow(
    'record contract test has no parseable contractRoutes literal: orchestrator/src/record/broken-contract.test.ts',
  )
})

test('a contract test with no contractRoutes mention is skipped', () => {
  expect(
    contractRoutesFromSource(
      'orchestrator/src/record/unrelated-contract.test.ts',
      "test('an unrelated contract', () => {})",
    ),
  ).toBeNull()
})
