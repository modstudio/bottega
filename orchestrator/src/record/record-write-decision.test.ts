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
  ).toEqual({ verdict: 'hosted' })
  expect(
    decideRecordWrite({
      recordApiConfigured: false,
      installBound: false,
      boundOrigin: null,
      resolvedOrigin,
    }),
  ).toEqual({ verdict: 'local-authoritative' })
  expect(
    decideRecordWrite({
      recordApiConfigured: false,
      installBound: true,
      boundOrigin: null,
      resolvedOrigin,
    }),
  ).toMatchObject({
    verdict: 'refused',
    boundOrigin: null,
    resolvedOrigin,
    refusal: expect.stringContaining('no recorded address'),
  })
  expect(
    decideRecordWrite({
      recordApiConfigured: false,
      installBound: true,
      boundOrigin: resolvedOrigin,
      resolvedOrigin,
    }),
  ).toEqual({ verdict: 'hosted' })
  expect(
    decideRecordWrite({
      recordApiConfigured: false,
      installBound: true,
      boundOrigin: 'https://staging.example.test',
      resolvedOrigin,
    }),
  ).toMatchObject({
    verdict: 'refused',
    boundOrigin: 'https://staging.example.test',
    resolvedOrigin,
    refusal: expect.stringContaining('record use https://staging.example.test'),
  })
})
