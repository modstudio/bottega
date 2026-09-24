import { describe, expect, test } from 'bun:test'
import { type AddressedCanonRow, composeCanonRows, planHydration } from './canon-hydrate.ts'

describe('planHydration', () => {
  test('three levels compose in order and every pairwise collision refuses', () => {
    const global = [{ subject: null, owner: null, slug: 'AGENTS.md', body: 'global' }]
    const user = [{ subject: null, owner: 'user-1', slug: '.agents/rules/user.md', body: 'user' }]
    const project = [
      { subject: 'known', owner: null, slug: '.agents/rules/project.md', body: 'project' },
    ]
    expect(composeCanonRows(global, user, project).map((row) => row.body)).toEqual([
      'global',
      'user',
      'project',
    ])
    const pairs: [AddressedCanonRow[], AddressedCanonRow[]][] = [
      [global, user],
      [global, project],
      [user, project],
    ]
    for (const [left, right] of pairs) {
      expect(() => composeCanonRows(left, [{ ...right[0]!, slug: left[0]!.slug }], [])).toThrow(
        'canon path collision',
      )
    }
  })

  test('global and project rows rendering to one path refuse and name both', () => {
    expect(() =>
      composeCanonRows(
        [{ subject: null, slug: '.agents/rules/shared.md', body: 'global' }],
        [],
        [{ subject: 'known', slug: '.agents/rules/shared.md', body: 'project' }],
      ),
    ).toThrow(
      'canon/_/.agents/rules/shared.md and canon/known/.agents/rules/shared.md render to the same path',
    )
  })

  test('an identical tree has an empty plan', () => {
    expect(
      planHydration({
        rows: [{ slug: 'AGENTS.md', body: 'same' }],
        tree: [
          { path: 'AGENTS.md', text: 'same' },
          { path: 'CLAUDE.md', text: 'same', symlinkTarget: 'AGENTS.md' },
        ],
      }),
    ).toEqual({ writes: [], links: [], deletes: [] })
  })

  test('changed and missing rows become writes', () => {
    expect(
      planHydration({
        rows: [
          { slug: 'AGENTS.md', body: 'next' },
          { slug: '.agents/rules/style.md', body: 'new' },
        ],
        tree: [
          { path: 'AGENTS.md', text: 'old' },
          { path: 'CLAUDE.md', text: 'old', symlinkTarget: 'AGENTS.md' },
          { path: '.claude/rules', text: '', symlinkTarget: '../.agents/rules' },
        ],
      }).writes,
    ).toEqual([
      { path: '.agents/rules/style.md', body: 'new' },
      { path: 'AGENTS.md', body: 'next' },
    ])
  })

  test('a tree canon file absent from rows becomes a delete', () => {
    expect(
      planHydration({ rows: [], tree: [{ path: '.agents/reference/old.md', text: 'old' }] })
        .deletes,
    ).toEqual(['.agents/reference/old.md'])
  })

  test('contexts and rules publish only their generated directory links', () => {
    expect(
      planHydration({
        rows: [{ slug: '.agents/contexts/api.md', body: 'context' }],
        tree: [],
      }).links,
    ).toEqual([{ path: '.agents/rules/contexts', target: '../contexts' }])
    expect(
      planHydration({
        rows: [
          { slug: '.agents/contexts/api.md', body: 'context' },
          { slug: '.agents/rules/style.md', body: 'rule' },
        ],
        tree: [],
      }).links,
    ).toEqual([
      { path: '.agents/rules/contexts', target: '../contexts' },
      { path: '.claude/rules', target: '../.agents/rules' },
    ])
  })

  test('a subdirectory folder card gets a sibling alias', () => {
    expect(
      planHydration({ rows: [{ slug: 'orchestrator/AGENTS.md', body: 'card' }], tree: [] }).links,
    ).toEqual([{ path: 'orchestrator/CLAUDE.md', target: 'AGENTS.md' }])
  })

  test('a non-canon slug is refused', () => {
    expect(() => planHydration({ rows: [{ slug: 'README.md', body: '' }], tree: [] })).toThrow(
      'refusing non-canon slug "README.md"',
    )
  })
})
