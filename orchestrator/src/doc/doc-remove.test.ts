import { expect, test } from 'bun:test'
import { getDoc, listDocRevisions, removeDoc, setDoc } from './docs.ts'

test('document removal records the deletion before removing the live row', async () => {
  await setDoc({
    scope: 'global',
    subject: null,
    slug: 'remove-history',
    title: 'Remove history',
    body: 'Body.',
    delivery: 'demand',
    reason: 'create removal fixture',
  })
  expect(await removeDoc('global', null, 'remove-history', { reason: 'remove fixture' })).toBe(true)
  expect(getDoc('global', null, 'remove-history')).toBeNull()
  expect(listDocRevisions('global', null, 'remove-history').map(({ op }) => op)).toContain('delete')
})
