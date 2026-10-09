import { describe, expect, test } from 'bun:test'
import { canonDriftCondition } from './monitor-canon-drift.ts'

const project = { name: 'sample' }
const landed = { ref: 'origin/main', commit: '0123456789abcdef' }

describe('canon drift monitor decision', () => {
  test('raises one project-keyed condition for drift', () => {
    expect(
      canonDriftCondition(project, {
        ...landed,
        drift: [{ path: '.agents/rules/a.md', operation: 'write' }],
        projectRowCount: 1,
        deleteCount: 0,
      }),
    ).toEqual({
      kind: 'canon-drift',
      subject: 'sample',
      since: null,
      detail:
        'sample landed canon at origin/main (0123456789abcdef) differs from stored canon: .agents/rules/a.md',
      action:
        'run orch canon hydrate in a worktree, commit the hydrated paths, and land the branch',
      affectedProject: 'sample',
    })
  })

  test('stays quiet when the checkout is in sync', () => {
    expect(
      canonDriftCondition(project, {
        ...landed,
        drift: [],
        projectRowCount: 1,
        deleteCount: 0,
      }),
    ).toBeNull()
  })

  test('caps displayed paths and reports the remainder', () => {
    const drift = Array.from({ length: 7 }, (_, index) => ({
      path: `.agents/rules/${index}.md`,
      operation: 'write' as const,
    }))
    expect(
      canonDriftCondition(project, {
        ...landed,
        drift,
        projectRowCount: 1,
        deleteCount: 0,
      })?.detail,
    ).toEndWith(
      '.agents/rules/0.md, .agents/rules/1.md, .agents/rules/2.md, .agents/rules/3.md, .agents/rules/4.md, and 2 more',
    )
  })

  test('an empty project store names import as the remedy instead of hydrate', () => {
    expect(
      canonDriftCondition(project, {
        ...landed,
        drift: [{ path: 'AGENTS.md', operation: 'delete' }],
        projectRowCount: 0,
        deleteCount: 1,
      }),
    ).toEqual({
      kind: 'canon-drift',
      subject: 'sample',
      since: null,
      detail: 'sample: this store holds no project canon while the tree has managed canon paths',
      action: 'orch canon import --project',
      affectedProject: 'sample',
    })
  })
})
