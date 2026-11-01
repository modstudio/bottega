import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations, questionDocFilingOrphanCount } from './migrations.ts'
import {
  fixtureProjectRecordId,
  migratedTestDatabase,
  migrationBoundaryTestDatabase,
} from './test-database.fixture.ts'

const MIGRATION = '0194_question_doc_filing_record_id'

function insertFilingFixture(database: Database): {
  revisionRecordId: string
  runRecordId: string
} {
  const documentRecordId = newRecordId()
  const revisionRecordId = newRecordId()
  const runRecordId = newRecordId()
  const projectRecordId = fixtureProjectRecordId(database)
  database
    .query(
      `INSERT INTO doc
       (record_id,scope,subject,slug,title,body,delivery,created_at,updated_at,audiences)
       VALUES (?,'project','fixture','ruling','Ruling','Body','demand','a','a','["technical"]')`,
    )
    .run(documentRecordId)
  database
    .query(
      `INSERT INTO doc_revision
       (record_id,number,doc_record_id,scope,subject,slug,op,title,body,delivery,author,reason,at,audiences)
       VALUES (?,41,?,'project','fixture','ruling','create','Ruling','Body','demand','tester','fixture','a','["technical"]')`,
    )
    .run(revisionRecordId, documentRecordId)
  database
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id)
       VALUES (?,1,'a','codex','test','sha',1,'p','ok',?)`,
    )
    .run(runRecordId, projectRecordId)
  return { revisionRecordId, runRecordId }
}

function insertQuestion(
  database: Database,
  input: {
    number: number
    runRecordId: string
    filedRef: string
    filedRecordId: string | null
  },
): void {
  database
    .query(
      `INSERT INTO question
       (record_id,number,run_record_id,asked_at,question,asked_via,filed_as,filed_ref,filed_record_id)
       VALUES (?,?,?,'a','q','reply','doc',?,?)`,
    )
    .run(newRecordId(), input.number, input.runRecordId, input.filedRef, input.filedRecordId)
}

test('question doc filing preflight resolves only through the UUID sibling', () => {
  const valid = migratedTestDatabase()
  const missing = migratedTestDatabase()
  const unresolvable = migratedTestDatabase()
  try {
    const validFixture = insertFilingFixture(valid)
    insertQuestion(valid, {
      number: 1,
      runRecordId: validFixture.runRecordId,
      filedRef: 'project/fixture/ruling@41',
      filedRecordId: validFixture.revisionRecordId,
    })
    expect(questionDocFilingOrphanCount(valid)).toBe(0)

    const missingFixture = insertFilingFixture(missing)
    insertQuestion(missing, {
      number: 1,
      runRecordId: missingFixture.runRecordId,
      filedRef: 'project/fixture/ruling@41',
      filedRecordId: null,
    })
    expect(questionDocFilingOrphanCount(missing)).toBe(1)

    const unresolvableFixture = insertFilingFixture(unresolvable)
    unresolvable.exec('PRAGMA foreign_keys=OFF')
    insertQuestion(unresolvable, {
      number: 1,
      runRecordId: unresolvableFixture.runRecordId,
      filedRef: 'project/fixture/ruling@41',
      filedRecordId: newRecordId(),
    })
    expect(questionDocFilingOrphanCount(unresolvable)).toBe(1)
  } finally {
    valid.close()
    missing.close()
    unresolvable.close()
  }
})

test('question doc filing backfill resolves number and UUID suffixes', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    const fixture = insertFilingFixture(database)
    insertQuestion(database, {
      number: 1,
      runRecordId: fixture.runRecordId,
      filedRef: 'project/fixture/ruling@41',
      filedRecordId: null,
    })
    insertQuestion(database, {
      number: 2,
      runRecordId: fixture.runRecordId,
      filedRef: `41@${fixture.revisionRecordId}`,
      filedRecordId: null,
    })
    insertQuestion(database, {
      number: 3,
      runRecordId: fixture.runRecordId,
      filedRef: 'project/fixture/missing@999',
      filedRecordId: null,
    })

    expect(applyMigrations(database)).toContain(MIGRATION)
    expect(
      database
        .query<{ number: number; filed_record_id: string | null }, []>(
          'SELECT number,filed_record_id FROM question ORDER BY number',
        )
        .all(),
    ).toEqual([
      { number: 1, filed_record_id: fixture.revisionRecordId },
      { number: 2, filed_record_id: fixture.revisionRecordId },
      { number: 3, filed_record_id: null },
    ])
    expect(applyMigrations(database)).toEqual([])
    expect(questionDocFilingOrphanCount(database)).toBe(1)
  } finally {
    database.close()
  }
})
