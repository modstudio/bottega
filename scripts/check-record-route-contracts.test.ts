import { expect, test } from 'bun:test'
import { undeclaredRecordRoutes } from './check-record-route-contracts.ts'

test('an undeclared new record route is refused', () => {
  expect(
    undeclaredRecordRoutes(
      ['GET /v1/covered', 'POST /v1/baselined', 'PUT /v1/new'],
      new Set(['GET /v1/covered']),
      [{ route: 'POST /v1/baselined', reason: 'untested' }],
    ),
  ).toEqual(['PUT /v1/new'])
})
