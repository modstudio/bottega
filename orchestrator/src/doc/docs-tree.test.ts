import { expect, test } from 'bun:test'
import { getDoc, getDocRevision, listDocRevisions, listDocs, setDoc } from './docs.ts'

test('audience, parent, position, and featured round trip through set, list, and history', async () => {
  const parent = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'tree-parent',
    title: 'Tree parent',
    body: 'Parent.',
    delivery: 'demand',
    audiences: ['technical', 'internal'],
    position: 2,
    reason: 'create tree parent',
  })
  const child = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'tree-child',
    title: 'Tree child',
    body: 'Child.',
    delivery: 'demand',
    audiences: ['technical'],
    parentSlug: parent.slug,
    position: 7,
    featured: true,
    reason: 'create tree child',
  })
  expect(getDoc('global', null, child.slug)).toMatchObject({
    audiences: ['technical'],
    parent_id: parent.id,
    parent_slug: parent.slug,
    position: 7,
    featured: true,
  })
  expect(listDocs({ scope: 'global', audience: 'internal' })).toContainEqual(parent)
  expect(listDocs({ scope: 'global', audience: 'technical' })).toContainEqual(parent)
  expect(getDocRevision(listDocRevisions('global', null, child.slug)[0]!.id)).toMatchObject({
    audiences: ['technical'],
    parent_id: parent.id,
    position: 7,
    featured: true,
  })
})

test('article creation requires audiences while working documents default to technical', async () => {
  await expect(
    setDoc({
      scope: 'global',
      subject: null,
      slug: 'article-without-audiences',
      title: 'Article',
      body: 'Article body.',
      delivery: 'demand',
      kind: 'article',
      reason: 'prove deliberate article audience',
    }),
  ).rejects.toThrow('--audience')
  const working = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'working-default-audience',
    title: 'Working',
    body: 'Working body.',
    delivery: 'demand',
    reason: 'prove working default audience',
  })
  expect(working.audiences).toEqual(['technical'])
})
