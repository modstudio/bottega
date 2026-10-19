import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { REFERENCE_GENERATOR } from './doc-generator.ts'
import { consumeDoc, getDoc, importDoc, listDocRevisions, restoreDoc, setDoc } from './docs.ts'
import { publishReferenceDocs, slugLinkedBody } from './reference-publish.ts'

test('reference publishing is the only write path and is idempotent and removing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reference-publish-'))
  try {
    const directory = join(root, 'docs/reference')
    mkdirSync(directory, { recursive: true })
    const indexFile = 'docs/reference/index.md'
    const taskFile = 'docs/reference/task.md'
    writeFileSync(join(root, indexFile), '# Command reference\n\n- [task](./task.md)\n')
    writeFileSync(join(root, taskFile), '# task\n\nTasks.\n')
    upsertProject({
      recordId: newRecordId(),
      name: PLATFORM_SLUG,
      path: process.cwd(),
      settings: {},
    })
    await setDoc({
      scope: 'project',
      subject: PLATFORM_SLUG,
      slug: 'cli',
      title: 'CLI',
      body: '# CLI\n\nOld.\n',
      delivery: 'demand',
      audiences: ['technical', 'customer'],
      kind: 'article',
      form: 'overview',
      reason: 'fixture',
    })

    await expect(
      setDoc({
        scope: 'project',
        subject: PLATFORM_SLUG,
        slug: 'new-reference',
        title: 'No',
        body: '# No\n',
        delivery: 'demand',
        audiences: ['technical'],
        kind: 'article',
        form: 'reference',
        reason: 'hand write',
      }),
    ).rejects.toThrow(`${PLATFORM_SLUG} doc reference publish`)

    await expect(
      setDoc({
        scope: 'project',
        subject: PLATFORM_SLUG,
        slug: 'marked-prose',
        title: 'Marked prose',
        body: 'This was previously lint-invalid.',
        delivery: 'demand',
        reason: 'invalid generator marker',
        generator: REFERENCE_GENERATOR,
      }),
    ).rejects.toThrow('generator marker is reserved for reference documents')
    expect(getDoc('project', PLATFORM_SLUG, 'marked-prose')).toBeNull()

    expect(await publishReferenceDocs(root, [indexFile, taskFile])).toEqual([
      { slug: 'cli', disposition: 'updated' },
      { slug: 'cli-task', disposition: 'created' },
    ])
    const revisionCount = db()
      .query<{ count: number }, []>('SELECT count(*) AS count FROM doc_revision')
      .get()!.count
    expect(await publishReferenceDocs(root, [indexFile, taskFile])).toEqual([
      { slug: 'cli', disposition: 'unchanged' },
      { slug: 'cli-task', disposition: 'unchanged' },
    ])
    expect(
      db().query<{ count: number }, []>('SELECT count(*) AS count FROM doc_revision').get()!.count,
    ).toBe(revisionCount)
    const existing = getDoc('project', PLATFORM_SLUG, 'cli-task')!
    await expect(
      setDoc({
        scope: existing.scope,
        subject: existing.subject,
        slug: existing.slug,
        title: existing.title,
        body: `${existing.body}\nhand edit`,
        reason: 'hand write',
      }),
    ).rejects.toThrow(`${PLATFORM_SLUG} doc reference publish`)
    await expect(
      setDoc({
        scope: existing.scope,
        subject: existing.subject,
        slug: existing.slug,
        title: existing.title,
        body: existing.body,
        reason: 'generator write',
        generator: REFERENCE_GENERATOR,
      }),
    ).resolves.toBeTruthy()
    const revision = listDocRevisions('project', PLATFORM_SLUG, existing.slug).at(-1)!
    await expect(
      consumeDoc('project', PLATFORM_SLUG, existing.slug, { reason: 'hand consume' }),
    ).rejects.toThrow(`${PLATFORM_SLUG} doc reference publish`)
    await expect(
      restoreDoc('project', PLATFORM_SLUG, existing.slug, revision.id, {
        reason: 'hand restore',
      }),
    ).rejects.toThrow(`${PLATFORM_SLUG} doc reference publish`)
    await expect(
      importDoc({
        scope: 'project',
        subject: PLATFORM_SLUG,
        slug: existing.slug,
        title: existing.title,
        body: existing.body,
        delivery: 'demand',
        reason: 'hand import',
      }),
    ).rejects.toThrow(`${PLATFORM_SLUG} doc reference publish`)

    writeFileSync(join(root, indexFile), '# Command reference\n\nIndex.\n')
    expect(await publishReferenceDocs(root, [indexFile])).toContainEqual({
      slug: 'cli-task',
      disposition: 'removed',
    })
    expect(getDoc('project', PLATFORM_SLUG, 'cli-task')).toBeNull()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)

test('an ordinary article already at a generated slug is converted, not reported unchanged', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reference-publish-collision-'))
  try {
    mkdirSync(join(root, 'docs/reference'), { recursive: true })
    const indexFile = 'docs/reference/index.md'
    const taskFile = 'docs/reference/task.md'
    writeFileSync(join(root, indexFile), '# Command reference\n\n- [task](./task.md)\n')
    writeFileSync(join(root, taskFile), '# task\n\nTasks.\n')
    upsertProject({
      recordId: newRecordId(),
      name: PLATFORM_SLUG,
      path: process.cwd(),
      settings: {},
    })
    const article = {
      scope: 'project' as const,
      subject: PLATFORM_SLUG,
      delivery: 'demand' as const,
      audiences: ['technical'] as ['technical'],
      kind: 'article' as const,
      form: 'overview' as const,
      reason: 'fixture',
    }
    await setDoc({ ...article, slug: 'cli', title: 'CLI', body: '# CLI\n\nOld.\n' })
    await setDoc({
      ...article,
      slug: 'cli-task',
      title: 'task',
      body: '# task\n\nTasks.\n',
      parentSlug: 'cli',
      position: 0,
    })

    expect(await publishReferenceDocs(root, [indexFile, taskFile])).toContainEqual({
      slug: 'cli-task',
      disposition: 'updated',
    })
    expect(getDoc('project', PLATFORM_SLUG, 'cli-task')?.form).toBe('reference')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a page link names the sibling slug the reader serves, keeping its anchor', () => {
  expect(
    slugLinkedBody(
      '- [doc](./doc.md)\n- [audit](./doc.md#workshop-doc-canon-audit)\n- [all](./index.md)\n- [here](#x)\n- [web](https://e.x/a.md)\n',
      'index.md',
    ),
  ).toBe(
    '- [doc](cli-doc)\n- [audit](cli-doc#workshop-doc-canon-audit)\n- [all](cli)\n- [here](#x)\n- [web](https://e.x/a.md)\n',
  )
})
