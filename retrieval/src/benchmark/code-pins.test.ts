import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkCodePins } from './code-pins.ts'
import { CODE_QUERIES, REAL_CODE_QUERIES } from './queries.ts'

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
