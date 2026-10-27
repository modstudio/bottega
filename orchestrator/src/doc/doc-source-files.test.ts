import { expect, test } from 'bun:test'
import { mergeDocSourceFiles } from './doc-source-files.ts'

test.each([
  {
    behavior: 'add',
    existing: ['docs/first.md'],
    given: ['src/second.ts', 'docs/third.md'],
    replace: false,
    expected: ['docs/first.md', 'src/second.ts', 'docs/third.md'],
  },
  {
    behavior: 'drop duplicates while adding',
    existing: ['docs/first.md', 'src/second.ts'],
    given: ['src/second.ts', 'docs/third.md', 'docs/third.md'],
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
  {
    behavior: 'clear',
    existing: ['docs/first.md'],
    given: [],
    replace: true,
    expected: [],
  },
])('$behavior document source files', ({ existing, given, replace, expected }) => {
  expect(mergeDocSourceFiles(existing, given, replace)).toEqual([...expected])
})
