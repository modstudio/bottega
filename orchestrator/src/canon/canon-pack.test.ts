import { beforeEach, describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { cloneRepository } from '../../../shared/test-git-repository.ts'
import { setDoc } from '../../test/fixtures/docs.ts'
import { db } from '../database/db.ts'
import { docsForRun, docsMarkdown } from '../doc/docs.ts'
import { JOBS } from '../jobs/jobs.ts'
import { upsertProject } from '../project/projects.ts'
import { CanonBudgetError, compilePack, storedPackDrift } from './canon.ts'

const AT = '2026-09-15T00:00:00.000Z'
let repositoryPath = ''

beforeEach(() => {
  repositoryPath = cloneRepository(process.env, 'canon-pack-project-')
})

function putCanon(
  subject: string | null,
  slug: string,
  body: string,
  status: 'draft' | 'current' = 'current',
): void {
  const projectId = subject
    ? (db().query('SELECT id FROM project WHERE name=?').get(subject) as { id: number }).id
    : null
  const id = (
    db()
      .query(
        `INSERT INTO doc (scope, subject, project_id, slug, title, body, delivery, audiences, status, created_at, updated_at, record_id)
         VALUES ('canon', ?, ?, ?, ?, ?, 'demand', '["technical"]', ?, ?, ?, ?) RETURNING id`,
      )
      .get(subject, projectId, slug, slug, body, status, AT, AT, newRecordId()) as { id: number }
  ).id
  db()
    .query(
      `INSERT INTO doc_revision
       (doc_id, scope, subject, project_id, slug, op, title, body, delivery, audiences, status, author, reason, at)
       VALUES (?, 'canon', ?, ?, ?, 'create', ?, ?, 'demand', '["technical"]', ?, 'test', 'test write', ?)`,
    )
    .run(id, subject, projectId, slug, slug, body, status, AT)
}

function operatorPack(cwd: string): string {
  return docsMarkdown(docsForRun({ job: 'understand', cwd }))
}

async function putOperator(body: string): Promise<void> {
  await setDoc({ scope: 'job', subject: 'understand', slug: 'operator', title: 'Operator', body })
}

describe('worker pack canon', () => {
  test('draft canon is absent from a compiled pack', () => {
    upsertProject({ name: 'pack-draft-canon', path: repositoryPath, settings: { trunk: 'main' } })
    putCanon('pack-draft-canon', 'AGENTS.md', 'CURRENT-CANON-UNIQUE\n')
    putCanon('pack-draft-canon', '.agents/rules/draft.md', 'DRAFT-CANON-UNIQUE\n', 'draft')
    const markdown = compilePack({ job: 'understand', cwd: repositoryPath }).markdown
    expect(markdown).toContain('CURRENT-CANON-UNIQUE')
    expect(markdown).not.toContain('DRAFT-CANON-UNIQUE')
  })

  test(`run 4177 canon-pack-drift review-lens/${PLATFORM_SLUG} resolves global and project rows once`, () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/, '')
    upsertProject({ name: PLATFORM_SLUG, path: root, settings: { trunk: 'main' } })
    const projectId = (
      db().query('SELECT id FROM project WHERE name=?').get(PLATFORM_SLUG) as { id: number }
    ).id
    const docs = JSON.stringify([
      {
        revisionId: 4177,
        scope: 'global',
        subject: null,
        slug: 'removed-run-4177-doc',
        title: 'Removed',
        bytes: 1,
      },
    ])
    const insert = db().query(
      `INSERT INTO canon_pack
       (job,project,project_id,sha256,bytes,doc_count,doc_revisions,compiled_at,findings)
       VALUES (?,?,?,?,?,?,?,?,0)`,
    )
    insert.run('review-lens', null, null, 'global', 1, 1, docs, AT)
    insert.run('review-lens', PLATFORM_SLUG, projectId, 'project', 1, 1, docs, AT)

    expect(storedPackDrift().map(({ job, project }) => [job, project])).toEqual([
      ['review-lens', PLATFORM_SLUG],
    ])
  })

  test('always-on rows appear in the pack in entry-then-rules order', async () => {
    upsertProject({ name: 'pack-canon-order', path: repositoryPath, settings: { trunk: 'main' } })
    await putOperator('OPERATOR-DOC-UNIQUE')
    putCanon('pack-canon-order', 'AGENTS.md', 'ENTRY-BODY-UNIQUE\n')
    putCanon(
      'pack-canon-order',
      '.agents/rules/alpha.md',
      '---\ndescription: A rule\n---\nRULE-BODY-UNIQUE\n',
    )
    const pack = compilePack({ job: 'understand', cwd: repositoryPath })
    expect(pack.markdown.indexOf('ENTRY-BODY-UNIQUE')).toBeGreaterThanOrEqual(0)
    expect(pack.markdown.indexOf('RULE-BODY-UNIQUE')).toBeGreaterThan(
      pack.markdown.indexOf('ENTRY-BODY-UNIQUE'),
    )
    expect(pack.markdown.indexOf('OPERATOR-DOC-UNIQUE')).toBeGreaterThan(
      pack.markdown.indexOf('RULE-BODY-UNIQUE'),
    )
    expect(pack.docs.map((doc) => doc.slug)).toEqual(['operator'])
  })

  test('global always-on rows pack before project rows of the same tier', async () => {
    upsertProject({ name: 'pack-global-order', path: repositoryPath, settings: { trunk: 'main' } })
    putCanon(null, '.agents/rules/global.md', '---\ndescription: Global\n---\nGLOBAL-RULE-UNIQUE\n')
    putCanon(
      'pack-global-order',
      '.agents/rules/project.md',
      '---\ndescription: Project\n---\nPROJECT-RULE-UNIQUE\n',
    )
    const markdown = compilePack({ job: 'understand', cwd: repositoryPath }).markdown
    expect(markdown.indexOf('GLOBAL-RULE-UNIQUE')).toBeLessThan(
      markdown.indexOf('PROJECT-RULE-UNIQUE'),
    )
  })

  test('a context row contributes one index line and never its body', async () => {
    upsertProject({ name: 'pack-canon-context', path: repositoryPath, settings: { trunk: 'main' } })
    await putOperator('operator')
    putCanon(
      'pack-canon-context',
      '.agents/contexts/api.md',
      '---\ndescription: API surface\npaths:\n  - src/**\n  - tests/**\n---\nCONTEXT-BODY-MUST-NOT-APPEAR\n',
    )
    const pack = compilePack({ job: 'understand', cwd: repositoryPath })
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

  test('a card row contributes nothing', async () => {
    upsertProject({ name: 'pack-canon-card', path: repositoryPath, settings: { trunk: 'main' } })
    await putOperator('operator')
    putCanon(
      'pack-canon-card',
      'hub/AGENTS.md',
      '## Purpose\n\nP\n\n## Belongs here\n\nB\n\n## Does not belong here\n\nD\n\n## May depend on\n\nM\nCARD-BODY-MUST-NOT-APPEAR\n',
    )
    const pack = compilePack({ job: 'understand', cwd: repositoryPath })
    expect(pack.markdown).toBe(operatorPack(repositoryPath))
    expect(pack.markdown).not.toContain('CARD-BODY-MUST-NOT-APPEAR')
    expect(pack.canonBytes).toBe(0)
    expect(pack.docBytes).toBe(pack.bytes)
  })

  test('the pack refuses over budget with a message naming the tier to demote', async () => {
    upsertProject({ name: 'pack-canon-budget', path: repositoryPath, settings: { trunk: 'main' } })
    await putOperator('t')
    putCanon('pack-canon-budget', 'AGENTS.md', `${'E'.repeat(400)}\n`)
    const measured = compilePack({ job: 'understand', cwd: repositoryPath })
    const old = JOBS.understand!.packBytes
    JOBS.understand!.packBytes = measured.bytes - 1
    try {
      expect(() => compilePack({ job: 'understand', cwd: repositoryPath })).toThrow(
        CanonBudgetError,
      )
      let message = ''
      try {
        compilePack({ job: 'understand', cwd: repositoryPath })
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain('always-on')
      expect(message).toContain('largest packed tier: always-on')
      expect(message).toContain(
        'never raise the pack budget (orchestrator/src/canon/pack-budget.ts)',
      )
      expect(message).not.toMatch(/increase the budget|larger number|raise DEFAULT_PACK_BYTES/)
    } finally {
      JOBS.understand!.packBytes = old
    }
  })

  test("a project with no canon rows produces today's pack exactly", async () => {
    upsertProject({ name: 'pack-canon-none', path: repositoryPath, settings: { trunk: 'main' } })
    await setDoc({
      scope: 'job',
      subject: 'understand',
      slug: 'injected',
      title: 'Injected',
      body: 'today',
    })
    const pack = compilePack({ job: 'understand', cwd: repositoryPath })
    const today = operatorPack(repositoryPath)
    expect(pack.markdown).toBe(today)
    expect(pack.bytes).toBe(Buffer.byteLength(today))
    expect(pack.canonBytes).toBe(0)
    expect(pack.docBytes).toBe(pack.bytes)
    expect(pack.docs.map((doc) => doc.slug)).toEqual(['injected'])
  })
})
