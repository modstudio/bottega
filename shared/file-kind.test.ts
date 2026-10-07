import { describe, expect, test } from 'bun:test'
import { categorizeFile } from './file-kind.ts'

describe('categorizeFile', () => {
  test.each([
    ['orchestrator/src/doc/docs.ts', 'product'],
    ['hub/web/src/docs/page.tsx', 'product'],
    ['orchestrator/src/doc/docs-core.test.ts', 'test'],
    ['docs/guide.txt', 'docs'],
    ['packages/x/docs/notes.txt', 'docs'],
    ['orchestrator/src/doc/README.md', 'docs'],
  ] as const)('%s is %s', (path, kind) => {
    expect(categorizeFile(path)).toBe(kind)
  })
})
