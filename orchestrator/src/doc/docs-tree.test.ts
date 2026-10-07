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
    audience: 'user',
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
    audience: 'user',
    parentSlug: parent.slug,
    position: 7,
    featured: true,
    reason: 'create tree child',
  })
  expect(getDoc('global', null, child.slug)).toMatchObject({
    audience: 'user',
    parent_id: parent.id,
    parent_slug: parent.slug,
    position: 7,
    featured: true,
  })
  expect(listDocs({ scope: 'global', audience: 'user' })).toContainEqual(child)
  expect(getDocRevision(listDocRevisions('global', null, child.slug)[0]!.id)).toMatchObject({
    audience: 'user',
    parent_id: parent.id,
    position: 7,
    featured: true,
  })
})
