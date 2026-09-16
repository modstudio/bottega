import { describe, expect, test } from 'bun:test'
import { managedBlockPlan, omitKeys } from './env-file.ts'

function planned(base: string, tree = 'tree', body = 'PORT=1'): string {
  const plan = managedBlockPlan(base, tree, body)
  expect(plan.ok).toBeTrue()
  return plan.ok ? plan.text : ''
}

describe('managed recipe env blocks', () => {
  test('appends one block after a blank line with or without a trailing newline', () => {
    const block = '# >>> orch-worktree tree\nPORT=1\n# <<< orch-worktree tree'
    expect(planned('BASE=1')).toBe(`BASE=1\n\n${block}`)
    expect(planned('BASE=1\n')).toBe(`BASE=1\n\n${block}`)
    expect(planned('BASE=1\n\n')).toBe(`BASE=1\n\n${block}`)
  })

  test('replaces the body in place and leaves surrounding bytes identical', () => {
    const base =
      'before\r\n# >>> orch-worktree tree\r\nOLD=yes\r\n# <<< orch-worktree tree\r\nafter\r\n'
    expect(planned(base, 'tree', 'NEW=yes')).toBe(
      'before\r\n# >>> orch-worktree tree\nNEW=yes\n# <<< orch-worktree tree\r\nafter\r\n',
    )
  })

  test('refuses an unclosed opening and names its line', () => {
    expect(managedBlockPlan('first\n# >>> orch-worktree tree\nsecret', 'tree', 'NEW=yes')).toEqual({
      ok: false,
      reason: 'managed block opening on line 2 has no closing line',
    })
  })

  test('refuses two complete blocks and names both opening lines', () => {
    const base =
      '# >>> orch-worktree tree\na\n# <<< orch-worktree tree\n' +
      'middle\n# >>> orch-worktree tree\nb\n# <<< orch-worktree tree\n'
    expect(managedBlockPlan(base, 'tree', 'NEW=yes')).toEqual({
      ok: false,
      reason: 'more than one managed block opens on lines 1, 5',
    })
  })

  test('is idempotent for the same body', () => {
    const once = planned('BASE=1\n', 'tree', 'PORT=1\nNAME=tree')
    expect(planned(once, 'tree', 'PORT=1\nNAME=tree')).toBe(once)
  })

  test('does not count or alter a project-style block on append or replace', () => {
    const project = '# >>> worktree (tree)\nPROJECT=yes\n# <<< worktree (tree)\n'
    const appended = planned(project)
    expect(appended.startsWith(project)).toBeTrue()
    expect(planned(appended, 'tree', 'PORT=2').startsWith(project)).toBeTrue()
    expect(planned(appended, 'tree', 'PORT=2')).toContain('PROJECT=yes')
  })
})

describe('inherited env omission', () => {
  test('drops assignment forms and preserves every non-assignment line', () => {
    const base =
      'KEY=one\nexport KEY=two\n  KEY = three\n\n# KEY=four\nOTHER=KEY\ntext KEY=elsewhere\n'
    expect(omitKeys(base, ['KEY'])).toBe('\n# KEY=four\nOTHER=KEY\ntext KEY=elsewhere\n')
  })
})
