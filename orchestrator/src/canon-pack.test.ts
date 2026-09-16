import { describe, expect, test } from 'bun:test'
import { setDoc } from '../test/fixtures/docs.ts'
import { dir } from '../test/fixtures/store.ts'
import { CanonBudgetError, compileBrief, compilePack } from './canon.ts'
import { db } from './db.ts'
import { docsForRun, docsMarkdown } from './docs.ts'
import { JOBS } from './jobs.ts'
import { upsertProject } from './projects.ts'

const AT = '2026-09-15T00:00:00.000Z'

function putCanon(subject: string, slug: string, body: string): void {
  const projectId = (
    db().query('SELECT id FROM project WHERE name=?').get(subject) as { id: number }
  ).id
  const id = (
    db()
      .query(
        `INSERT INTO doc (scope, subject, project_id, slug, title, body, delivery, created_at, updated_at)
         VALUES ('canon', ?, ?, ?, ?, ?, 'demand', ?, ?) RETURNING id`,
      )
      .get(subject, projectId, slug, slug, body, AT, AT) as { id: number }
  ).id
  db()
    .query(
      `INSERT INTO doc_revision
       (doc_id, scope, subject, project_id, slug, op, title, body, delivery, author, reason, at)
       VALUES (?, 'canon', ?, ?, ?, 'create', ?, ?, 'demand', 'test', 'test write', ?)`,
    )
    .run(id, subject, projectId, slug, slug, body, AT)
}

function operatorPack(cwd: string): string {
  return docsMarkdown(docsForRun({ job: 'understand', cwd }))
}

describe('worker pack canon', () => {
  test('always-on rows appear in the pack in entry-then-rules order', () => {
    upsertProject({ name: 'pack-canon-order', path: dir, settings: { trunk: 'main' } })
    setDoc({
      scope: 'global',
      subject: null,
      slug: 'operator',
      title: 'Operator',
      body: 'OPERATOR-DOC-UNIQUE',
    })
    putCanon('pack-canon-order', 'AGENTS.md', 'ENTRY-BODY-UNIQUE\n')
    putCanon(
      'pack-canon-order',
      '.agents/rules/alpha.md',
      '---\ndescription: A rule\n---\nRULE-BODY-UNIQUE\n',
    )
    const pack = compilePack({ job: 'understand', cwd: dir })
    expect(pack.markdown.indexOf('ENTRY-BODY-UNIQUE')).toBeGreaterThanOrEqual(0)
    expect(pack.markdown.indexOf('RULE-BODY-UNIQUE')).toBeGreaterThan(
      pack.markdown.indexOf('ENTRY-BODY-UNIQUE'),
    )
    expect(pack.markdown.indexOf('OPERATOR-DOC-UNIQUE')).toBeGreaterThan(
      pack.markdown.indexOf('RULE-BODY-UNIQUE'),
    )
    expect(pack.docs.map((doc) => doc.slug)).toEqual(['operator'])
    expect(compileBrief(dir).markdown).not.toContain('ENTRY-BODY-UNIQUE')
    expect(compileBrief(dir).markdown).not.toContain('RULE-BODY-UNIQUE')
  })

  test('a context row contributes one index line and never its body', () => {
    upsertProject({ name: 'pack-canon-context', path: dir, settings: { trunk: 'main' } })
    setDoc({
      scope: 'global',
      subject: null,
      slug: 'operator',
      title: 'Operator',
      body: 'operator',
    })
    putCanon(
      'pack-canon-context',
      '.agents/contexts/api.md',
      '---\ndescription: API surface\npaths:\n  - src/**\n  - tests/**\n---\nCONTEXT-BODY-MUST-NOT-APPEAR\n',
    )
    const pack = compilePack({ job: 'understand', cwd: dir })
    expect(pack.markdown).toContain('## Path-scoped contexts')
    expect(pack.markdown).toContain(
      'Read the context file in your worktree before editing a path it governs.',
    )
    expect(pack.markdown).toContain(
      '- `.agents/contexts/api.md` — API surface — `src/**`, `tests/**`',
    )
    expect(pack.markdown).not.toContain('CONTEXT-BODY-MUST-NOT-APPEAR')
    expect(pack.docs.map((doc) => doc.slug)).toEqual(['operator'])
  })

  test('a card row contributes nothing', () => {
    upsertProject({ name: 'pack-canon-card', path: dir, settings: { trunk: 'main' } })
    setDoc({
      scope: 'global',
      subject: null,
      slug: 'operator',
      title: 'Operator',
      body: 'operator',
    })
    putCanon(
      'pack-canon-card',
      'hub/AGENTS.md',
      '## Purpose\n\nP\n\n## Belongs here\n\nB\n\n## Does not belong here\n\nD\n\n## May depend on\n\nM\nCARD-BODY-MUST-NOT-APPEAR\n',
    )
    const pack = compilePack({ job: 'understand', cwd: dir })
    expect(pack.markdown).toBe(operatorPack(dir))
    expect(pack.markdown).not.toContain('CARD-BODY-MUST-NOT-APPEAR')
    expect(pack.canonBytes).toBe(0)
    expect(pack.docBytes).toBe(pack.bytes)
  })

  test('the pack refuses over budget with a message naming the tier to demote', () => {
    upsertProject({ name: 'pack-canon-budget', path: dir, settings: { trunk: 'main' } })
    setDoc({
      scope: 'global',
      subject: null,
      slug: 'tiny',
      title: 'Tiny',
      body: 't',
    })
    putCanon('pack-canon-budget', 'AGENTS.md', `${'E'.repeat(400)}\n`)
    const measured = compilePack({ job: 'understand', cwd: dir })
    const old = JOBS.understand!.packBytes
    JOBS.understand!.packBytes = measured.bytes - 1
    try {
      expect(() => compilePack({ job: 'understand', cwd: dir })).toThrow(CanonBudgetError)
      let message = ''
      try {
        compilePack({ job: 'understand', cwd: dir })
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain('always-on')
      expect(message).toContain('largest packed tier: always-on')
      expect(message).toContain('never raise the pack budget (orchestrator/src/pack-budget.ts)')
      expect(message).not.toMatch(/increase the budget|larger number|raise DEFAULT_PACK_BYTES/)
    } finally {
      JOBS.understand!.packBytes = old
    }
  })

  test("a project with no canon rows produces today's pack exactly", () => {
    upsertProject({ name: 'pack-canon-none', path: dir, settings: { trunk: 'main' } })
    setDoc({
      scope: 'global',
      subject: null,
      slug: 'injected',
      title: 'Injected',
      body: 'today',
    })
    const pack = compilePack({ job: 'understand', cwd: dir })
    const today = operatorPack(dir)
    expect(pack.markdown).toBe(today)
    expect(pack.bytes).toBe(Buffer.byteLength(today))
    expect(pack.canonBytes).toBe(0)
    expect(pack.docBytes).toBe(pack.bytes)
    expect(pack.docs.map((doc) => doc.slug)).toEqual(['injected'])
  })
})
