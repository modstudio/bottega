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
      recordApiConfigured: true,
      installBound: true,
      boundOrigin: 'https://staging.example.test',
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
  const unknownOrigin = decideRecordWrite({
    recordApiConfigured: false,
    installBound: true,
    boundOrigin: null,
    resolvedOrigin,
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
