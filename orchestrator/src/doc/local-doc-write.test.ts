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
    audience: 'technical' as const,
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
