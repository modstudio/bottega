import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { listDocRevisions, readDocRevision, setDoc } from './docs.ts'

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
  const id = listDocRevisions('global', null, 'revision-other')[0]!.id

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
  const id = listDocRevisions('global', null, 'revision-audience')[0]!.id

  const revision = readDocRevision('global', null, 'revision-audience', id, null, 'internal')

  expect(revision.body).toContain('Shared.')
  expect(revision.body).toContain('Internal.')
  expect(revision.body).not.toContain('Technical.')
})
