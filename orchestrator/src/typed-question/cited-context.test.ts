import { expect, test } from 'bun:test'
import { CITED_FILE_BYTES, CITED_TOTAL_BYTES, citedContext } from './cited-context.ts'

test('extracts resolvable cited paths, removes suffixes, and de-duplicates in citation order', () => {
  const files = new Map([
    ['src/first.ts', 'first'],
    ['src/second.ts', 'second'],
  ])
  expect(
    citedContext(
      'Read `src/first.ts`, then src/second.ts:42 and src/missing.ts; cite src/first.ts:symbol again.',
      (path) => files.get(path) ?? null,
    ),
  ).toEqual([
    { path: 'src/first.ts', text: 'first' },
    { path: 'src/second.ts', text: 'second' },
  ])
})

test('truncates every cited file and the complete context by byte limits', () => {
  const spec = Array.from({ length: 5 }, (_, index) => `src/file-${index}.ts`).join(' ')
  const files = citedContext(spec, () => 'x'.repeat(CITED_FILE_BYTES + 10))
  expect(files.map((file) => Buffer.byteLength(file.text))).toEqual([
    CITED_FILE_BYTES,
    CITED_FILE_BYTES,
    CITED_FILE_BYTES,
    CITED_FILE_BYTES,
  ])
  expect(files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0)).toBe(CITED_TOTAL_BYTES)
})
