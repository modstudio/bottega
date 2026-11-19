import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { writeCursor } from '../record/record-cache-cursor.ts'
import { registerLocalProject } from './project-registration.ts'

const candidate = (name: string) => ({
  recordId: newRecordId(),
  name,
  path: `/w/${name}`,
  stack: null,
  canon: false,
  retiredAt: null,
  settings: {},
})

test('registration rolls back the project row when its cache rewind fails', () => {
  writeCursor(db(), 'record_change_pull_spaces', JSON.stringify(['space-a']))
  writeCursor(db(), 'record_subjects_cursor:space-a', '{}')
  db().exec(`CREATE TEMP TRIGGER fail_registration_rewind
    BEFORE DELETE ON schema_meta
    WHEN OLD.key = 'record_subjects_cursor:space-a'
    BEGIN SELECT RAISE(FAIL, 'forced cursor clear failure'); END`)

  expect(() => registerLocalProject(candidate('atomic-registration'), 'space-a', db())).toThrow(
    'forced cursor clear failure',
  )
  expect(db().query("SELECT 1 FROM project WHERE name='atomic-registration'").get()).toBeNull()
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_project_spaces'").get(),
  ).toBeNull()
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_subjects_cursor:space-a'").get(),
  ).toEqual({ value: '{}' })
})

test('registration clears keyset cursors and schedules both fallbacks', () => {
  writeCursor(db(), 'record_change_pull_spaces', JSON.stringify(['space-a']))
  writeCursor(db(), 'record_subjects_cursor:space-a', '{}')
  writeCursor(db(), 'record_docs_cursor:space-a', '{}')

  registerLocalProject(candidate('rewound-registration'), 'space-a', db())

  expect(db().query("SELECT 1 FROM project WHERE name='rewound-registration'").get()).not.toBeNull()
  expect(
    db().query("SELECT 1 FROM schema_meta WHERE key='record_subjects_cursor:space-a'").get(),
  ).toBeNull()
  expect(
    db().query("SELECT 1 FROM schema_meta WHERE key='record_docs_cursor:space-a'").get(),
  ).toBeNull()
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_change_fallbacks'").get(),
  ).toEqual({ value: JSON.stringify(['doc:space-a', 'subject:space-a']) })
})

test('registration rewinds only a space this machine already pulls', () => {
  writeCursor(db(), 'record_subjects_cursor:space-outside', '{}')
  writeCursor(db(), 'record_docs_cursor:space-outside', '{}')

  registerLocalProject(candidate('outside-pulled-spaces'), 'space-outside', db())

  expect(
    db()
      .query("SELECT value FROM schema_meta WHERE key='record_subjects_cursor:space-outside'")
      .get(),
  ).toEqual({ value: '{}' })
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_docs_cursor:space-outside'").get(),
  ).toEqual({ value: '{}' })
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_change_fallbacks'").get(),
  ).toBeNull()
})
