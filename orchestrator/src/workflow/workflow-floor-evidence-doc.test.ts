import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import {
  type CursorIdentity,
  docAdmissibleAsCursorEvidence,
  gatherValidatedEvidence,
} from './workflow-floor-evidence.ts'

test('accepts a document in a project-less scope on any cursor', () => {
  expect(
    docAdmissibleAsCursorEvidence({ scope: 'global', subject: null, projectName: null }, 'fixture'),
  ).toBe(true)
  expect(
    docAdmissibleAsCursorEvidence(
      { scope: 'machine', subject: null, projectName: null },
      'fixture',
    ),
  ).toBe(true)
})

test("accepts a document scoped to the cursor's own project", () => {
  expect(
    docAdmissibleAsCursorEvidence(
      { scope: 'project', subject: 'fixture', projectName: 'fixture' },
      'fixture',
    ),
  ).toBe(true)
  expect(
    docAdmissibleAsCursorEvidence(
      { scope: 'resume', subject: 'fixture', projectName: null },
      'fixture',
    ),
  ).toBe(true)
})

test('refuses a document scoped to another project', () => {
  expect(
    docAdmissibleAsCursorEvidence(
      { scope: 'project', subject: 'other', projectName: 'other' },
      'fixture',
    ),
  ).toBe(false)
  expect(
    docAdmissibleAsCursorEvidence(
      { scope: 'resume', subject: 'other', projectName: null },
      'fixture',
    ),
  ).toBe(false)
})

const identity: CursorIdentity = {
  project: 'fixture',
  workflowKey: 'DEV-977',
  branch: 'DEV-977-work',
  worktree: null,
  session: 's',
  createdAt: '2026-09-01',
  stepActivatedAt: '2026-09-01',
}

const database = testDatabaseFixture((d) => {
  d.query(
    `INSERT INTO doc (scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,project_record_id,record_id)
     VALUES ('machine',NULL,'note','t','b','inject','["technical"]','t','t',NULL,?)`,
  ).run(newRecordId())
})

test('admits a machine-scope document with no project as evidence on another project cursor', () => {
  const gathered = gatherValidatedEvidence({
    cursorId: newRecordId(),
    identity,
    stepOrdinal: 1,
    stepSlug: 'rebase',
    floors: [],
    evidence: { artifact: 'doc:machine/_/note' },
    ports: {},
    d: database(),
  })
  expect(gathered.artifact).toEqual({ ref: 'doc:machine/_/note', exists: true })
})
