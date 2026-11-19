import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
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

test('registration rolls back the project row when remembering its space fails', () => {
  db().exec(`CREATE TEMP TRIGGER fail_registration_space
    BEFORE INSERT ON schema_meta
    WHEN NEW.key = 'record_project_spaces'
    BEGIN SELECT RAISE(FAIL, 'forced project space failure'); END`)

  expect(() => registerLocalProject(candidate('atomic-registration'), 'space-a', db())).toThrow(
    'forced project space failure',
  )
  expect(db().query("SELECT 1 FROM project WHERE name='atomic-registration'").get()).toBeNull()
  expect(
    db().query("SELECT value FROM schema_meta WHERE key='record_project_spaces'").get(),
  ).toBeNull()
})
