import { describe, expect, test } from 'bun:test'
import { refuseCanonWrite } from './doc-write-allowed.ts'

const rule = {
  slug: '.agents/rules/10-code.md',
  body: '---\ndescription: Code\nalways: true\n---\n\nCite `architecture.ts`.\n',
}

describe('refuseCanonWrite tree facts', () => {
  test('accepts a repository path citation when tree facts are absent, and refuses when they are supplied without the path', () => {
    expect(
      refuseCanonWrite({
        current: [],
        next: [rule],
      }),
    ).toBeNull()
    expect(
      refuseCanonWrite({
        current: [],
        next: [rule],
        trackedPaths: [],
        packageScripts: [],
        sourceTexts: [],
      }),
    ).toContain('repository path architecture.ts is not tracked')
  })

  test('still refuses a writing rule when tree facts are absent', () => {
    expect(
      refuseCanonWrite({
        current: [],
        next: [
          {
            slug: '.agents/rules/10-code.md',
            body: '---\ndescription: Code\nalways: true\n---\n\nIt used to be different.\n',
          },
        ],
      }),
    ).toContain('canon/history')
  })
})
