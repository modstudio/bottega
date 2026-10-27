import { expect, test } from 'bun:test'
import {
  docSourceFileExpectedRevision,
  docSourceFileUpdateMode,
  mergeDocSourceFiles,
} from './doc-source-files.ts'

test.each([
  {
    behavior: 'add',
    existing: ['docs/first.md'],
    given: ['src/second.ts', 'docs/third.md'],
    replace: false,
    expected: ['docs/first.md', 'src/second.ts', 'docs/third.md'],
  },
  {
    behavior: 'replace',
    existing: ['docs/first.md'],
    given: ['src/second.ts', 'src/second.ts', 'docs/third.md'],
    replace: true,
    expected: ['src/second.ts', 'docs/third.md'],
  },
])('$behavior document source files', ({ existing, given, replace, expected }) => {
  expect(mergeDocSourceFiles(existing, given, replace)).toEqual([...expected])
})

test.each([
  ['add', 'prior-revision', undefined, 'prior-revision'],
  ['add', undefined, undefined, undefined],
  ['add', 'prior-revision', 'operator-revision', 'operator-revision'],
  ['replace', 'prior-revision', undefined, undefined],
  ['clear', 'prior-revision', undefined, undefined],
  ['replace', 'prior-revision', 'operator-revision', 'operator-revision'],
  ['clear', 'prior-revision', 'operator-revision', 'operator-revision'],
] as const)(
  '%s source-file updates with prior %s and operator expectation %s use %s',
  (mode, prior, operator, expected) => {
    expect(docSourceFileExpectedRevision(mode, prior, operator)).toBe(expected)
  },
)

test.each([
  [{ given: ['src/one.ts'], replace: false }, 'add'],
  [{ given: ['src/one.ts'], replace: true }, 'replace'],
  [{ given: [], replace: true }, 'clear'],
] as const)('classifies source-file update %# as %s', (update, expected) => {
  expect(docSourceFileUpdateMode(update)).toBe(expected)
})
