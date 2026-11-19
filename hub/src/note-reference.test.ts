import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { resolveNoteReference } from './note.ts'

test('a qualified note reference refuses an unregistered project before lookup', () => {
  expect(() => resolveNoteReference('unregistered#41', 'workshop')).toThrow(
    `project 'unregistered' is not registered; run \`${PLATFORM_SLUG} project list\``,
  )
})
