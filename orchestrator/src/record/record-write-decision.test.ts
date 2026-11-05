import { expect, test } from 'bun:test'
import { decideRecordWrite } from './record-write-decision.ts'

test('shared-state writes are hosted, local-authoritative, or refused from install facts', () => {
  const resolvedOrigin = 'https://api.example.test'
  expect(
    decideRecordWrite({
      recordApiConfigured: true,
      installBound: false,
      boundOrigin: null,
      resolvedOrigin,
    }),
  ).toBe('hosted')
  expect(
    decideRecordWrite({
      recordApiConfigured: false,
      installBound: false,
      boundOrigin: null,
      resolvedOrigin,
    }),
  ).toBe('local-authoritative')
  expect(
    decideRecordWrite({
      recordApiConfigured: false,
      installBound: true,
      boundOrigin: null,
      resolvedOrigin,
    }),
  ).toBe('hosted')
  expect(
    decideRecordWrite({
      recordApiConfigured: false,
      installBound: true,
      boundOrigin: resolvedOrigin,
      resolvedOrigin,
    }),
  ).toBe('hosted')
  expect(
    decideRecordWrite({
      recordApiConfigured: false,
      installBound: true,
      boundOrigin: 'https://staging.example.test',
      resolvedOrigin,
    }),
  ).toBe('refused')
})
