import { describe, expect, test } from 'bun:test'
import { globalCanonWriteTargets, refuseCanonWrite } from './doc-write-allowed.ts'

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

describe('globalCanonWriteTargets', () => {
  const candidate = (name: string, managedContext?: boolean) => ({
    name,
    path: `/w/${name}`,
    settings: { managedContext },
  })

  test('selects only projects opted into managed context', () => {
    const managed = candidate('managed', true)
    expect(globalCanonWriteTargets([candidate('unmanaged'), managed])).toEqual([managed])
  })

  test('falls back to checking global rows alone when no project is opted in', () => {
    expect(globalCanonWriteTargets([candidate('unmanaged', false)])).toEqual([null])
    expect(globalCanonWriteTargets([])).toEqual([null])
  })
})
