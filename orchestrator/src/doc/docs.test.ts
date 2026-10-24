import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { upsertProject } from '../project/projects.ts'
import { addSubject } from '../subject/subjects.ts'
import { getDoc, listDocRevisions, readDocRevision, setDoc, setDocCheckedAgainst } from './docs.ts'

test('an addressed revision read refuses an id from another document with the history remedy', async () => {
  await setDoc({
    scope: 'global',
    subject: null,
    slug: 'revision-owner',
    title: 'Owner',
    body: 'owned\n',
    delivery: 'demand',
    reason: 'create owner',
  })
  await setDoc({
    scope: 'global',
    subject: null,
    slug: 'revision-other',
    title: 'Other',
    body: 'other\n',
    delivery: 'demand',
    reason: 'create other',
  })
  const id = listDocRevisions('global', null, 'revision-other')[0]!.record_id

  expect(() => readDocRevision('global', null, 'revision-owner', id)).toThrow(
    `revision ${id} does not belong to global/_/revision-owner; run ${PLATFORM_SLUG} doc history global - revision-owner`,
  )
})

test('an addressed revision read applies the requested audience projection', async () => {
  await setDoc({
    scope: 'global',
    subject: null,
    slug: 'revision-audience',
    title: 'Audience',
    body: 'Shared.\n\n:::section{audience="technical"}\nTechnical.\n:::\n\n:::section{audience="internal"}\nInternal.\n:::\n',
    delivery: 'demand',
    audiences: ['technical', 'internal'],
    reason: 'create audience revision',
  })
  const id = listDocRevisions('global', null, 'revision-audience')[0]!.record_id

  const revision = readDocRevision('global', null, 'revision-audience', id, null, 'internal')

  expect(revision.body).toContain('Shared.')
  expect(revision.body).toContain('Internal.')
  expect(revision.body).not.toContain('Technical.')
})

const checkedCommit = '1111111111111111111111111111111111111111'

test('setDocCheckedAgainst records the commit and keeps every other field', async () => {
  upsertProject({ recordId: newRecordId(), name: 'drifted', path: '/w/drifted' })
  const topic = await addSubject({ project: 'drifted', name: 'Topic', definition: 'Topic.' })
  const related = await addSubject({ project: 'drifted', name: 'Related', definition: 'Related.' })
  await setDoc({
    scope: 'project',
    subject: 'drifted',
    slug: 'replacement',
    title: 'Replacement',
    body: 'Replacement prose.\n',
    delivery: 'demand',
    kind: 'article',
    audiences: ['technical'],
    reason: 'create the replacement',
  })
  await setDoc({
    scope: 'project',
    subject: 'drifted',
    slug: 'audited',
    title: 'Audited',
    body: 'Audited prose.\n',
    delivery: 'demand',
    kind: 'article',
    audiences: ['technical'],
    form: 'feature',
    articleSubject: topic.id,
    relatedSubjects: [related.id],
    sourceFiles: ['src/one.ts'],
    summary: 'What the document says.',
    status: 'superseded',
    replacementSlug: 'replacement',
    reason: 'create the audited document',
  })

  const checked = await setDocCheckedAgainst('project', 'drifted', 'audited', checkedCommit, {
    reason: 'record the checked commit',
  })

  const kept = {
    title: 'Audited',
    body: 'Audited prose.\n',
    delivery: 'demand',
    audiences: ['technical'],
    kind: 'article',
    form: 'feature',
    articleSubject: { id: topic.id },
    relatedSubjects: [{ id: related.id }],
    sourceFiles: ['src/one.ts'],
    summary: 'What the document says.',
    status: 'superseded',
    replacement_slug: 'replacement',
    checkedAgainstCommit: checkedCommit,
  }
  expect(checked).toMatchObject(kept)
  expect(getDoc('project', 'drifted', 'audited')).toMatchObject(kept)
})

test('setDocCheckedAgainst refuses an absent document with the listing remedy', async () => {
  upsertProject({ recordId: newRecordId(), name: 'drifted', path: '/w/drifted' })
  await expect(
    setDocCheckedAgainst('project', 'drifted', 'missing', checkedCommit, {
      reason: 'record the checked commit',
    }),
  ).rejects.toThrow(`no project doc "missing"; use ${PLATFORM_SLUG} doc list --scope project`)
})
