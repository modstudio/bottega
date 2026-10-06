import { describe, expect, test } from 'bun:test'
import {
  canonRemovalRefusal,
  decideDocRevisionWrite,
  globalCanonWriteTargets,
  refuseCanonWrite,
  refuseOwnedDocAddress,
  refuseSettingsAddress,
  userCanonWriteTargets,
} from './doc-write-allowed.ts'

test('owned settings share the owner-private address rule with canon', () => {
  const owner = '01990000-0000-7000-8000-000000000091'
  expect(refuseOwnedDocAddress('settings', null, owner)).toBeNull()
  expect(refuseOwnedDocAddress('canon', null, owner)).toBeNull()
  expect(refuseOwnedDocAddress('settings', 'alpha', owner)).toContain('canon or settings')
  expect(refuseOwnedDocAddress('project', null, owner)).toContain('canon or settings')
  expect(refuseOwnedDocAddress('settings', null, null)).toBeNull()
  expect(refuseSettingsAddress('settings', null, owner)).toBeNull()
  expect(refuseSettingsAddress('settings', 'alpha', null)).toBeNull()
  expect(refuseSettingsAddress('settings', null, null)).toContain('owner and no subject')
  expect(refuseSettingsAddress('canon', null, null)).toBeNull()
})

test('canon removal refusal names the citer and remedy', () => {
  expect(
    canonRemovalRefusal([
      {
        file: 'workflow step verify',
        line: 4,
        rule: 'canon/reference-path',
        message: 'repository path .agents/reference/target.md is not tracked',
      },
    ]),
  ).toBe(
    'refusing canon removal; introduced 1 reference finding:\n' +
      'workflow step verify:4 canon/reference-path repository path .agents/reference/target.md is not tracked\n' +
      'cleared by: update or remove the named citations first, then retry the removal',
  )
})

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

  test('user writes select every managed project or the user set alone', () => {
    const managed = candidate('managed', true)
    expect(userCanonWriteTargets([candidate('unmanaged'), managed])).toEqual([managed])
    expect(userCanonWriteTargets([])).toEqual([null])
  })
})

describe('decideDocRevisionWrite', () => {
  test('requires the current revision for an existing canon doc', () => {
    expect(
      decideDocRevisionWrite({ current: 'revision-2', isCreate: false, scope: 'canon' }),
    ).toEqual({
      allow: false,
      reason:
        'refusing canon update at current revision revision-2; pass --expect revision-2\n' +
        're-read with orch doc get and re-apply the edit',
    })
    expect(
      decideDocRevisionWrite({
        expected: 'revision-2',
        current: 'revision-2',
        isCreate: false,
        scope: 'canon',
      }),
    ).toEqual({ allow: true })
  })

  test('requires the current revision for an existing settings doc', () => {
    expect(
      decideDocRevisionWrite({ current: 'revision-2', isCreate: false, scope: 'settings' }),
    ).toEqual({
      allow: false,
      reason:
        'refusing settings update at current revision revision-2; pass --expect revision-2\n' +
        're-read with orch doc get and re-apply the edit',
    })
  })

  test('refuses stale optional tokens in other scopes and tokens for a create', () => {
    expect(
      decideDocRevisionWrite({ current: 'revision-2', isCreate: false, scope: 'global' }),
    ).toEqual({ allow: true })
    for (const input of [
      { expected: 'revision-1', current: 'revision-2', isCreate: false, scope: 'global' },
      { expected: 'revision-1', current: null, isCreate: true, scope: 'canon' },
    ]) {
      const decision = decideDocRevisionWrite(input)
      expect(decision.allow).toBe(false)
      if (!decision.allow) {
        expect(decision.reason).toContain('expected revision revision-1')
        expect(decision.reason).toContain('re-read with orch doc get and re-apply')
      }
    }
  })

  test('allows creates without a token in every scope', () => {
    expect(decideDocRevisionWrite({ current: null, isCreate: true, scope: 'canon' })).toEqual({
      allow: true,
    })
  })

  test('refuses an existing canon row whose revision is absent without inventing a token', () => {
    const decision = decideDocRevisionWrite({ current: null, isCreate: false, scope: 'canon' })
    expect(decision).toEqual({
      allow: false,
      reason:
        "refusing canon write: this row's latest revision is missing, so its revision cannot be checked\n" +
        'cleared by: repair the document revision state, then retry the write',
    })
    if (!decision.allow) expect(decision.reason).not.toContain('--expect')
  })
})
