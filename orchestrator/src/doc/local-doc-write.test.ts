import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { setDoc } from './docs.ts'
import { commitDocRestore, commitDocSet } from './local-doc-write.ts'

test('kind selects lint and an omitted kind keeps the current value', async () => {
  const article = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'article-profile',
    title: 'Article profile',
    body: 'There are 2 prices.',
    delivery: 'demand',
    kind: 'article',
    reason: 'create article profile fixture',
  })
  const updated = await setDoc({
    scope: article.scope,
    subject: article.subject,
    slug: article.slug,
    title: article.title,
    body: 'There are 3 prices.',
    delivery: article.delivery,
    reason: 'update article without kind',
    expectedRevision: article.revision!,
  })
  expect(updated.kind).toBe('article')
  await expect(
    setDoc({
      scope: 'global',
      subject: null,
      slug: 'working-profile',
      title: 'Working profile',
      body: 'There are 2 prices.',
      delivery: 'demand',
      reason: 'prove working profile refusal',
    }),
  ).rejects.toThrow(/working profile[\s\S]*doc\/numeral[\s\S]*--kind article/)
})

test('used-to warnings store for both document kinds', async () => {
  for (const kind of ['working', 'article'] as const) {
    await expect(
      setDoc({
        scope: 'machine',
        subject: null,
        slug: `used-to-${kind}`,
        title: `Used to ${kind}`,
        body: 'The page used to show totals. This field is used to compute the price.',
        delivery: 'demand',
        kind,
        reason: 'prove history warnings do not refuse writes',
      }),
    ).resolves.toMatchObject({ kind })
  }
})

test('an article cannot be created or changed to effective inject delivery', async () => {
  await expect(
    setDoc({
      scope: 'job',
      subject: 'understand',
      slug: 'article-inject-create',
      title: 'Article inject create',
      body: 'Current.',
      delivery: 'inject',
      kind: 'article',
      reason: 'prove create refusal',
    }),
  ).rejects.toThrow('kind article requires effective delivery demand')

  const injected = await setDoc({
    scope: 'job',
    subject: 'understand',
    slug: 'article-inject-kind-update',
    title: 'Article inject kind update',
    body: 'Current.',
    delivery: 'inject',
    reason: 'create injected working document',
  })
  await expect(
    setDoc({
      scope: injected.scope,
      subject: injected.subject,
      slug: injected.slug,
      title: injected.title,
      body: injected.body,
      kind: 'article',
      reason: 'prove kind update refusal',
    }),
  ).rejects.toThrow('kind article requires effective delivery demand')

  const article = await setDoc({
    scope: 'machine',
    subject: null,
    slug: 'article-inject-delivery-update',
    title: 'Article inject delivery update',
    body: 'Current.',
    delivery: 'demand',
    kind: 'article',
    reason: 'create demand article',
  })
  await expect(
    setDoc({
      scope: article.scope,
      subject: article.subject,
      slug: article.slug,
      title: article.title,
      body: article.body,
      delivery: 'inject',
      reason: 'prove delivery update refusal',
    }),
  ).rejects.toThrow('kind article requires effective delivery demand')
})

test('set and restore repair the project id on an existing document', () => {
  upsertProject({
    name: 'repair-project',
    path: '/w/repair',
    stack: null,
    canon: true,
    settings: {},
  })
  const project = db().query('SELECT id FROM project WHERE name=?').get('repair-project') as {
    id: number
  }
  const input = {
    scope: 'resume',
    subject: 'repair-project',
    owner: null,
    projectId: project.id,
    slug: 'repair-project-id',
    title: 'Resume',
    body: '---\nstatus: open\n---\n\nBody.',
    delivery: 'demand' as const,
    audiences: ['technical'] as ['technical'],
    parentId: null,
    position: 0,
    identity: { author: 'test', reason: 'repair project id', session: null },
    recordId: newRecordId(),
  }
  const created = commitDocSet({ ...input, revisionId: newRecordId() })

  db().query('UPDATE doc SET project_id=NULL WHERE id=?').run(created.id)
  commitDocSet({ ...input, revisionId: newRecordId() })
  expect(db().query('SELECT project_id FROM doc WHERE id=?').get(created.id)).toEqual({
    project_id: project.id,
  })

  db().query('UPDATE doc SET project_id=NULL WHERE id=?').run(created.id)
  commitDocRestore({ ...input, revisionId: newRecordId() })
  expect(db().query('SELECT project_id FROM doc WHERE id=?').get(created.id)).toEqual({
    project_id: project.id,
  })
})
