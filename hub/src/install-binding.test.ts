import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { writeTransaction } from './db.ts'
import { NEVER_BOUND } from './hosted-write-mode.ts'
import { persistInstallBinding, readInstallBinding } from './install-binding.ts'

beforeEach(resetFixtureStore)

test('a fresh store is never-bound until a hosted row or identity is remembered', () => {
  expect(readInstallBinding()).toEqual(NEVER_BOUND)
  writeTransaction((conn) => persistInstallBinding(conn, 'space-a'))
  expect(readInstallBinding()).toEqual({ bound: true, activeSpaceId: 'space-a' })
  writeTransaction((conn) => persistInstallBinding(conn, null))
  expect(readInstallBinding()).toEqual({ bound: true, activeSpaceId: 'space-a' })
})

test('a later persist with no space keeps the remembered space', () => {
  writeTransaction((conn) => persistInstallBinding(conn, 'space-a'))
  writeTransaction((conn) => persistInstallBinding(conn))
  expect(readInstallBinding()).toEqual({ bound: true, activeSpaceId: 'space-a' })
})
