import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const CONTEXT_SCOPE_BOUNDARY = '0207_context_doc_scope'

// Keep the boundary replay out of an individual test's timed body.
migrationBoundaryTestDatabase(CONTEXT_SCOPE_BOUNDARY).close()

function count(database: Database, table: string): number {
  return database.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()!.n
}

test('context scope rebuild keeps every doc row and the unique addresses', () => {
  const database = migrationBoundaryTestDatabase(CONTEXT_SCOPE_BOUNDARY)
  try {
    const ids = {
      project: newRecordId(),
      subject: newRecordId(),
      doc: newRecordId(),
      revision: newRecordId(),
      related: newRecordId(),
    }
    database
      .query(
        "INSERT INTO project(record_id,name,path,canon,settings) VALUES (?,'fixture','/fixture',1,'{}')",
      )
      .run(ids.project)
    database
      .query(
        "INSERT INTO subject(id,project_record_id,name,definition,position,created_at,updated_at) VALUES (?,?,'Docs','Docs.',0,'a','a')",
      )
      .run(ids.subject, ids.project)
    database
      .query(`INSERT INTO doc(record_id,scope,subject,slug,title,body,delivery,created_at,updated_at,audiences)
        VALUES (?,'global',NULL,'kept','Kept','Kept.','demand','a','a','["technical"]')`)
      .run(ids.doc)
    database
      .query(`INSERT INTO doc_revision(record_id,number,doc_record_id,scope,subject,slug,op,title,body,delivery,author,reason,at,audiences)
        VALUES (?,1,?,'global',NULL,'kept','create','Kept','Kept.','demand','tester','seed','a','["technical"]')`)
      .run(ids.revision, ids.doc)
    database
      .query('INSERT INTO doc_related_subject(record_id,doc_record_id,subject_id) VALUES (?,?,?)')
      .run(ids.related, ids.doc, ids.subject)

    expect(applyMigrations(database)).toContain(CONTEXT_SCOPE_BOUNDARY)

    expect([
      count(database, 'doc'),
      count(database, 'doc_revision'),
      count(database, 'doc_related_subject'),
    ]).toEqual([1, 1, 1])
    expect(
      database
        .query<{ name: string; unique: number }, []>(
          "SELECT name, \"unique\" FROM pragma_index_list('doc') WHERE name IN ('doc_address','doc_record_id') ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: 'doc_address', unique: 1 },
      { name: 'doc_record_id', unique: 1 },
    ])
    const insertContext = database.query(
      `INSERT INTO doc(record_id,scope,subject,slug,title,body,delivery,created_at,updated_at,audiences)
        VALUES (?,'context','task:DEV-1','next','Next','Body.','demand','a','a','["technical"]')`,
    )
    insertContext.run(newRecordId())
    expect(() => insertContext.run(newRecordId())).toThrow('UNIQUE')
  } finally {
    database.close()
  }
})
