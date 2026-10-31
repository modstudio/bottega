import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkCodePins } from './code-pins.ts'
import { CODE_QUERIES, REAL_CODE_QUERIES } from './queries.ts'

test('code benchmark provenance pins reject stale and missing sources after normalization', () => {
  const pin = (excerpt: string) => [
    {
      id: 'query',
      query: 'query',
      goldLabels: ['a.ts'],
      provenance: { path: 'a.ts', excerpt },
    },
  ]
  expect(checkCodePins(pin('gone'), [{ path: 'a.ts', body: 'other text' }])[0]!.current).toBeFalse()
  expect(
    checkCodePins(pin('const value = 1'), [{ path: 'a.ts', body: '**const** `value`   = 1' }])[0]!
      .current,
  ).toBeTrue()
  expect(checkCodePins(pin('present'), [])[0]!.current).toBeFalse()
})

test('code benchmark provenance pins match real repository files', () => {
  const root = resolve(import.meta.dir, '../../..')
  const queries = [...CODE_QUERIES, ...REAL_CODE_QUERIES]
  const paths = [...new Set(queries.map((query) => query.provenance.path))]
  const results = checkCodePins(
    queries,
    paths.map((path) => ({ path, body: readFileSync(resolve(root, path), 'utf8') })),
  )
  expect(results.filter((result) => !result.current)).toEqual([])
})
