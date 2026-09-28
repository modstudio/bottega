import { describe, expect, test } from 'bun:test'
import {
  composeCanonRows,
  hydrationDrift,
  mainCheckoutHydrationRefusal,
  planHydration,
} from './canon-hydrate.ts'
import { CODEX_PROJECT_DOC_MAX_BYTES } from './canon-load.ts'
import {
  CODEX_PROJECT_DOC_HEADER,
  CODEX_PROJECT_DOC_PATH,
  composeCodexProjectDoc,
} from './codex-project-doc.ts'

describe('hydration drift decisions', () => {
  const plan = {
    writes: [{ path: '.agents/rules/changed.md', body: 'stored' }],
    links: [],
    deletes: ['.agents/rules/removed.md', '.agents/rules/unchanged.md'],
  }

  test('a changed canon file matching the store passes', () => {
    expect(
      hydrationDrift({ writes: [], links: [], deletes: [] }, ['.agents/rules/changed.md']),
    ).toEqual([])
  })

  test('a changed canon file differing from the store is named', () => {
    expect(hydrationDrift(plan, ['.agents/rules/changed.md'])).toEqual([
      { path: '.agents/rules/changed.md', operation: 'write' },
    ])
  })

  test('an unchanged drifted file is ignored by a branch check', () => {
    expect(hydrationDrift(plan, ['.agents/rules/removed.md'])).toEqual([
      { path: '.agents/rules/removed.md', operation: 'delete' },
    ])
  })

  test('read-only checks allow main while hydration writes refuse it', () => {
    expect(mainCheckoutHydrationRefusal({ mainCheckout: true, check: true })).toBeFalse()
    expect(mainCheckoutHydrationRefusal({ mainCheckout: true, check: false })).toBeTrue()
    expect(mainCheckoutHydrationRefusal({ mainCheckout: false, check: false })).toBeFalse()
  })
})

describe('planHydration', () => {
  test('Codex project doc has the generated header, entry, then path-ordered always-on rules', () => {
    const doc = composeCodexProjectDoc([
      { slug: '.agents/contexts/scoped.md', body: 'context' },
      { slug: '.agents/rules/z-last.md', body: 'last\n' },
      { slug: 'AGENTS.md', body: 'entry\n' },
      { slug: '.agents/reference/on-demand.md', body: 'reference' },
      { slug: '.agents/rules/a-first.md', body: 'first\n' },
    ])

    expect(doc?.body).toBe(`${CODEX_PROJECT_DOC_HEADER}\n\nentry\n\nfirst\n\nlast\n`)
  })

  test('an over-limit Codex project doc refuses before returning any writes', () => {
    expect(() =>
      planHydration({
        rows: [{ slug: 'AGENTS.md', body: 'x'.repeat(CODEX_PROJECT_DOC_MAX_BYTES) }],
        tree: [],
      }),
    ).toThrow(
      new RegExp(
        `${CODEX_PROJECT_DOC_PATH} measures \\d+ bytes; limit ${CODEX_PROJECT_DOC_MAX_BYTES} bytes; largest contributing rows: AGENTS.md`,
      ),
    )
  })

  test('three levels compose in order and user paths do not collide with repository paths', () => {
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
    expect(() =>
      composeCanonRows(global, [{ ...user[0]!, slug: 'AGENTS.md' }], project),
    ).not.toThrow()
  })

  test('global and project collisions refuse while duplicate user home paths refuse', () => {
    expect(() =>
      composeCanonRows(
        [{ subject: null, slug: 'AGENTS.md', body: 'global' }],
        [],
        [{ subject: 'known', slug: 'AGENTS.md', body: 'project' }],
      ),
    ).toThrow('canon path collision')
    expect(() =>
      composeCanonRows(
        [],
        [
          { subject: null, owner: 'user-1', slug: 'AGENTS.md', body: 'one' },
          { subject: null, owner: 'user-1', slug: 'AGENTS.md', body: 'two' },
        ],
        [],
      ),
    ).toThrow('canon path collision')
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
    const generated = composeCodexProjectDoc([{ slug: 'AGENTS.md', body: 'same' }])!
    expect(
      planHydration({
        rows: [{ slug: 'AGENTS.md', body: 'same' }],
        tree: [
          { path: CODEX_PROJECT_DOC_PATH, text: generated.body },
          { path: 'AGENTS.md', text: 'same' },
          { path: 'CLAUDE.md', text: 'same', symlinkTarget: 'AGENTS.md' },
        ],
      }),
    ).toEqual({ writes: [], links: [], deletes: [] })
  })

  test('changed and missing rows become writes', () => {
    const plan = planHydration({
      rows: [
        { slug: 'AGENTS.md', body: 'next' },
        { slug: '.agents/rules/style.md', body: 'new' },
      ],
      tree: [
        { path: 'AGENTS.md', text: 'old' },
        { path: 'CLAUDE.md', text: 'old', symlinkTarget: 'AGENTS.md' },
        { path: '.claude/rules', text: '', symlinkTarget: '../.agents/rules' },
      ],
    })
    expect(plan.writes).toEqual([
      { path: '.agents/rules/style.md', body: 'new' },
      { path: 'AGENTS.md', body: 'next' },
      expect.objectContaining({ path: CODEX_PROJECT_DOC_PATH }),
    ])
  })

  test('--check drift includes the generated file when an always-on rule changes', () => {
    const currentRows = [
      { slug: 'AGENTS.md', body: 'entry' },
      { slug: '.agents/rules/style.md', body: 'old' },
    ]
    const nextRows = [currentRows[0]!, { slug: '.agents/rules/style.md', body: 'new' }]
    const currentDoc = composeCodexProjectDoc(currentRows)!
    const plan = planHydration({
      rows: nextRows,
      tree: [
        { path: 'AGENTS.md', text: 'entry' },
        { path: '.agents/rules/style.md', text: 'old' },
        { path: CODEX_PROJECT_DOC_PATH, text: currentDoc.body },
      ],
    })

    expect(hydrationDrift(plan)).toEqual([
      { path: '.agents/rules/style.md', operation: 'write' },
      { path: '.claude/rules', operation: 'link' },
      { path: CODEX_PROJECT_DOC_PATH, operation: 'write' },
      { path: 'CLAUDE.md', operation: 'link' },
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
