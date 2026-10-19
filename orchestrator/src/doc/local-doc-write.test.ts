import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { addSubject, retireSubject } from '../subject/subjects.ts'
import {
  getDocRevision,
  listDocRevisions,
  listDocs,
  restoreDoc,
  setDoc,
  storedDocWarnings,
} from './docs.ts'
import { commitDocRestore, commitDocSet } from './local-doc-write.ts'

test('latest revision follows its sequence when record ids sort in the opposite order', async () => {
  const created = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'revision-sequence-not-uuid-order',
    title: 'Revision sequence',
    body: 'Older body.',
    delivery: 'demand',
    audiences: ['technical'],
    reason: 'create ordering fixture',
  })
  const newer = await setDoc({
    scope: created.scope,
    subject: created.subject,
    slug: created.slug,
    title: created.title,
    body: 'Newer body.',
    delivery: created.delivery,
    audiences: created.audiences,
    reason: 'create newer ordering fixture',
    expectedRevision: created.revision!,
  })
  const revisions = db()
    .query<{ number: number; record_id: string }, [string]>(
      'SELECT number,record_id FROM doc_revision WHERE doc_record_id=? ORDER BY number',
    )
    .all(created.record_id)
  const olderRecordId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const newerRecordId = '00000000-0000-4000-8000-000000000001'
  db()
    .query('UPDATE doc_revision SET record_id=? WHERE number=?')
    .run(olderRecordId, revisions[0]!.number)
  db()
    .query('UPDATE doc_revision SET record_id=? WHERE number=?')
    .run(newerRecordId, revisions[1]!.number)

  expect((await import('./docs.ts')).getDoc('global', null, created.slug)?.revision).toBe(
    newerRecordId,
  )
  await expect(
    setDoc({
      scope: created.scope,
      subject: created.subject,
      slug: created.slug,
      title: created.title,
      body: 'Newest body.',
      delivery: created.delivery,
      audiences: created.audiences,
      reason: 'compare against sequence-selected revision',
      expectedRevision: newerRecordId,
    }),
  ).resolves.toMatchObject({ body: 'Newest body.' })
  expect(newer.revision).not.toBe(newerRecordId)
})

test('kind selects lint and an omitted kind keeps the current value', async () => {
  const article = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'article-profile',
    title: 'Article profile',
    body: 'There are 2 prices.',
    delivery: 'demand',
    kind: 'article',
    audiences: ['technical'],
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
  expect(storedDocWarnings(updated)).toContainEqual({
    line: 1,
    rule: 'doc/article-summary',
    level: 'warning',
    message: 'article has no written summary',
    remedy: `set one with ${PLATFORM_SLUG} doc set <slug> --summary`,
  })
  const working = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'working-profile',
    title: 'Working profile',
    body: 'Hebrew numbering writes 15 and 16 as טו and טז.',
    delivery: 'demand',
    reason: 'prove working profile warning',
  })
  expect(working.body).toBe('Hebrew numbering writes 15 and 16 as טו and טז.')
  expect(storedDocWarnings(working)).toEqual([
    expect.objectContaining({ rule: 'doc/numeral', level: 'warning' }),
  ])
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
        audiences: ['technical'],
        reason: 'prove history warnings do not refuse writes',
      }),
    ).resolves.toMatchObject({ kind })
  }
})

test('changing an article task-key warning into a working error is refused', async () => {
  const article = await setDoc({
    scope: 'machine',
    subject: null,
    slug: 'task-key-level-change',
    title: 'Task key level change',
    body: 'Catalog entry DEV-880 is current.',
    delivery: 'demand',
    kind: 'article',
    audiences: ['technical'],
    reason: 'create article warning fixture',
  })

  await expect(
    setDoc({
      scope: article.scope,
      subject: article.subject,
      slug: article.slug,
      title: article.title,
      body: article.body,
      kind: 'working',
      reason: 'prove warning cannot pay for an error',
      expectedRevision: article.revision!,
    }),
  ).rejects.toThrow(/working profile[\s\S]*contains a task key/)
})

test('an article task key does not hide a banned issue pattern', async () => {
  await expect(
    setDoc({
      scope: 'machine',
      subject: null,
      slug: 'task-key-with-issue',
      title: 'Task key with issue',
      body: 'DEV-880 is a workaround.',
      delivery: 'demand',
      kind: 'article',
      audiences: ['technical'],
      reason: 'prove the issue pattern still refuses the article',
    }),
  ).rejects.toThrow(/article profile[\s\S]*matches banned issue pattern.*workaround/)
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
      audiences: ['technical'],
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
    audiences: ['technical'],
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
    recordId: newRecordId(),
    name: 'repair-project',
    path: '/w/repair',
    stack: null,
    canon: true,
    settings: {},
  })
  const project = db()
    .query('SELECT record_id FROM project WHERE name=?')
    .get('repair-project') as {
    record_id: string
  }
  const input = {
    scope: 'resume',
    subject: 'repair-project',
    owner: null,
    projectId: project.record_id,
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

  db().query('UPDATE doc SET project_record_id=NULL WHERE record_id=?').run(created.record_id)
  commitDocSet({ ...input, revisionId: newRecordId() })
  expect(
    db().query('SELECT project_record_id FROM doc WHERE record_id=?').get(created.record_id),
  ).toEqual({
    project_record_id: project.record_id,
  })

  db().query('UPDATE doc SET project_record_id=NULL WHERE record_id=?').run(created.record_id)
  commitDocRestore({ ...input, revisionId: newRecordId() })
  expect(
    db().query('SELECT project_record_id FROM doc WHERE record_id=?').get(created.record_id),
  ).toEqual({
    project_record_id: project.record_id,
  })
})

test('article fields validate, keep omitted values, clear explicitly, and restore snapshots', async () => {
  upsertProject({ recordId: newRecordId(), name: 'articles', path: '/w/articles' })
  upsertProject({ recordId: newRecordId(), name: 'foreign', path: '/w/foreign' })
  const own = await addSubject({ project: 'articles', name: 'Own', definition: 'Own.' })
  const related = await addSubject({ project: 'articles', name: 'Related', definition: 'Related.' })
  const retired = await addSubject({ project: 'articles', name: 'Retired', definition: 'Retired.' })
  const other = await addSubject({ project: 'foreign', name: 'Other', definition: 'Other.' })
  await retireSubject('articles', retired.id)

  for (const sourceFiles of [[''], ['/absolute'], ['a/../b'], ['a', 'a']]) {
    await expect(
      setDoc({
        scope: 'project',
        subject: 'articles',
        slug: `bad-${sourceFiles.length}-${sourceFiles[0]?.length}`,
        title: 'Bad',
        body: 'Body.',
        delivery: 'demand',
        kind: 'article',
        audiences: ['technical'],
        sourceFiles,
        reason: 'prove path refusal',
      }),
    ).rejects.toThrow(/source file/)
  }
  await expect(
    setDoc({
      scope: 'project',
      subject: 'articles',
      slug: 'bad-checked-commit',
      title: 'Bad commit',
      body: 'Body.',
      delivery: 'demand',
      kind: 'article',
      audiences: ['technical'],
      checkedAgainstCommit: 'ABC123',
      reason: 'prove commit refusal',
    }),
  ).rejects.toThrow(
    'invalid checked-against commit: use the full lowercase 40-character hexadecimal git commit id',
  )
  await expect(
    setDoc({
      scope: 'project',
      subject: 'articles',
      slug: 'foreign-subject',
      title: 'Wrong',
      body: 'Body.',
      delivery: 'demand',
      kind: 'article',
      audiences: ['technical'],
      articleSubject: other.id,
      reason: 'prove project refusal',
    }),
  ).rejects.toThrow(`${PLATFORM_SLUG} doc subject list articles`)
  await expect(
    setDoc({
      scope: 'project',
      subject: 'articles',
      slug: 'retired-subject',
      title: 'Wrong',
      body: 'Body.',
      delivery: 'demand',
      kind: 'article',
      audiences: ['technical'],
      articleSubject: retired.id,
      reason: 'prove retired refusal',
    }),
  ).rejects.toThrow('is retired')
  await expect(
    setDoc({
      scope: 'project',
      subject: 'articles',
      slug: 'retired-related',
      title: 'Wrong',
      body: 'Body.',
      delivery: 'demand',
      kind: 'article',
      audiences: ['technical'],
      relatedSubjects: [retired.id],
      reason: 'prove retired related refusal',
    }),
  ).rejects.toThrow('is retired')

  const created = await setDoc({
    scope: 'project',
    subject: 'articles',
    slug: 'fields',
    title: 'Fields',
    body: 'One.',
    delivery: 'demand',
    kind: 'article',
    audiences: ['technical'],
    form: 'feature',
    articleSubject: own.id,
    relatedSubjects: [related.id],
    sourceFiles: ['src/one.ts'],
    checkedAgainstCommit: '1111111111111111111111111111111111111111',
    reason: 'create fields',
  })
  await retireSubject('articles', related.id)
  const kept = await setDoc({
    scope: 'project',
    subject: 'articles',
    slug: 'fields',
    title: 'Fields',
    body: 'Two.',
    reason: 'keep fields',
    expectedRevision: created.revision!,
  })
  expect(kept).toMatchObject({
    form: 'feature',
    articleSubject: { id: own.id },
    relatedSubjects: [{ id: related.id }],
    sourceFiles: ['src/one.ts'],
    checkedAgainstCommit: '1111111111111111111111111111111111111111',
  })
  const cleared = await setDoc({
    scope: 'project',
    subject: 'articles',
    slug: 'fields',
    title: 'Fields',
    body: 'Three.',
    form: null,
    articleSubject: null,
    relatedSubjects: [],
    sourceFiles: [],
    checkedAgainstCommit: null,
    reason: 'clear fields',
    expectedRevision: kept.revision!,
  })
  expect(cleared).toMatchObject({
    form: null,
    articleSubject: null,
    relatedSubjects: [],
    sourceFiles: [],
    checkedAgainstCommit: null,
  })
  const firstRevision = listDocRevisions('project', 'articles', 'fields').at(-1)!
  const restored = await restoreDoc('project', 'articles', 'fields', firstRevision.record_id, {
    reason: 'restore fields',
    expectedRevision: cleared.revision!,
  })
  expect(restored).toMatchObject({
    form: 'feature',
    articleSubject: { id: own.id },
    relatedSubjects: [{ id: related.id }],
    sourceFiles: ['src/one.ts'],
    checkedAgainstCommit: '1111111111111111111111111111111111111111',
  })
  expect(getDocRevision(firstRevision.record_id)?.sourceFiles).toEqual(['src/one.ts'])
  expect(getDocRevision(firstRevision.record_id)?.checkedAgainstCommit).toBe(
    '1111111111111111111111111111111111111111',
  )
})

test('subject filtering lists own-subject documents before related documents', async () => {
  upsertProject({ recordId: newRecordId(), name: 'filter-articles', path: '/w/filter-articles' })
  const subject = await addSubject({
    project: 'filter-articles',
    name: 'Topic',
    definition: 'Topic.',
  })
  await setDoc({
    scope: 'project',
    subject: 'filter-articles',
    slug: 'related-first-title',
    title: 'A related',
    body: 'Body.',
    delivery: 'demand',
    kind: 'article',
    audiences: ['technical'],
    relatedSubjects: [subject.id],
    reason: 'create related',
  })
  await setDoc({
    scope: 'project',
    subject: 'filter-articles',
    slug: 'own-last-title',
    title: 'Z own',
    body: 'Body.',
    delivery: 'demand',
    kind: 'article',
    audiences: ['technical'],
    articleSubject: subject.id,
    reason: 'create own',
  })
  expect(
    listDocs({ scope: 'project', subject: 'filter-articles', articleSubject: subject.id }).map(
      ({ slug }) => slug,
    ),
  ).toEqual(['own-last-title', 'related-first-title'])
})
