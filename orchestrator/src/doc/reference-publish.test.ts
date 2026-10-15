import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { REFERENCE_GENERATOR } from './doc-write-allowed.ts'
import { getDoc, setDoc } from './docs.ts'
import { publishReferenceDocs } from './reference-publish.ts'

test('reference publishing is the only write path and is idempotent and removing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reference-publish-'))
  try {
    const directory = join(root, 'docs/reference')
    mkdirSync(directory, { recursive: true })
    const indexFile = 'docs/reference/index.md'
    const taskFile = 'docs/reference/task.md'
    writeFileSync(join(root, indexFile), '# Command reference\n\n- [task](./task.md)\n')
    writeFileSync(join(root, taskFile), '# task\n\nTasks.\n')
    upsertProject({ name: PLATFORM_SLUG, path: process.cwd(), settings: {} })
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
    ).rejects.toThrow('bottega doc reference publish')

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
    ).rejects.toThrow('bottega doc reference publish')
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
