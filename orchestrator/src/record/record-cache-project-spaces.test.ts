import { expect, test } from 'bun:test'
import { db } from '../database/db.ts'
import { writeCursor } from './record-cache-cursor.ts'
import {
  rememberRecordCacheProjectSpaces,
  rewindChangedRecordCacheProjectSpaces,
} from './record-cache-project-spaces.ts'

test('ownership rewind clears both cursors and schedules both fallbacks atomically', () => {
  rememberRecordCacheProjectSpaces(db(), new Map([['existing', 'space-a']]))
  writeCursor(db(), 'record_subjects_cursor:space-a', '{}')
  writeCursor(db(), 'record_docs_cursor:space-a', '{}')
  db().exec(`CREATE TEMP TRIGGER fail_docs_cursor_clear
    BEFORE DELETE ON schema_meta
    WHEN OLD.key = 'record_docs_cursor:space-a'
    BEGIN SELECT RAISE(FAIL, 'forced docs cursor clear failure'); END`)

  expect(() =>
    rewindChangedRecordCacheProjectSpaces(
      db(),
      new Map([
        ['existing', 'space-a'],
        ['new-project', 'space-a'],
      ]),
      new Set(['space-a']),
    ),
  ).toThrow('forced docs cursor clear failure')
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_subjects_cursor:space-a'").get(),
  ).toEqual({ value: '{}' })
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_docs_cursor:space-a'").get(),
  ).toEqual({ value: '{}' })
  expect(
    db().query("SELECT 1 FROM schema_meta WHERE key='record_change_fallbacks'").get(),
  ).toBeNull()
})

test('missing snapshot rewinds a currently owned space pulled by the previous version', () => {
  writeCursor(db(), 'record_subjects_cursor:space-a', '{}')
  writeCursor(db(), 'record_docs_cursor:space-a', '{}')

  rewindChangedRecordCacheProjectSpaces(
    db(),
    new Map([['existing', 'space-a']]),
    new Set(['space-a']),
  )

  expect(
    db().query("SELECT 1 FROM schema_meta WHERE key='record_subjects_cursor:space-a'").get(),
  ).toBeNull()
  expect(
    db().query("SELECT 1 FROM schema_meta WHERE key='record_docs_cursor:space-a'").get(),
  ).toBeNull()
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_change_fallbacks'").get(),
  ).toEqual({ value: '["doc:space-a","subject:space-a"]' })
})

test('new mapping to a space not pulled previously does not rewind it', () => {
  rememberRecordCacheProjectSpaces(db(), new Map())
  writeCursor(db(), 'record_subjects_cursor:space-b', '{}')
  writeCursor(db(), 'record_docs_cursor:space-b', '{}')

  rewindChangedRecordCacheProjectSpaces(
    db(),
    new Map([['new-project', 'space-b']]),
    new Set(['space-a']),
  )

  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_subjects_cursor:space-b'").get(),
  ).toEqual({ value: '{}' })
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_docs_cursor:space-b'").get(),
  ).toEqual({ value: '{}' })
  expect(
    db().query("SELECT 1 FROM schema_meta WHERE key='record_change_fallbacks'").get(),
  ).toBeNull()
})

test('new mapping with a null destination does not rewind any space', () => {
  rememberRecordCacheProjectSpaces(db(), new Map())
  writeCursor(db(), 'record_subjects_cursor:space-a', '{}')
  writeCursor(db(), 'record_docs_cursor:space-a', '{}')

  rewindChangedRecordCacheProjectSpaces(
    db(),
    new Map([['refused-project', null]]),
    new Set(['space-a']),
  )

  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_subjects_cursor:space-a'").get(),
  ).toEqual({ value: '{}' })
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_docs_cursor:space-a'").get(),
  ).toEqual({ value: '{}' })
  expect(
    db().query("SELECT 1 FROM schema_meta WHERE key='record_change_fallbacks'").get(),
  ).toBeNull()
})
