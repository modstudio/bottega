import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const TABLES = ['doc', 'doc_revision', 'canon_pack', 'doc_related_subject'] as const
const DOC_UUID_BOUNDARY = '0130_doc_uuid_key'

// Keep the boundary replay out of an individual test's timed body.
migrationBoundaryTestDatabase(DOC_UUID_BOUNDARY).close()

function count(database: Database, table: string): number {
  return database.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()!.n
}

test('document UUID-key migration preserves rebuilt rows, record identities, and relationships', () => {
  const database = migrationBoundaryTestDatabase(DOC_UUID_BOUNDARY)
  database.exec('PRAGMA foreign_keys=ON')
  try {
    const ids = {
      project: newRecordId(),
      parent: newRecordId(),
      child: newRecordId(),
      parentRevision: newRecordId(),
      childRevision: newRecordId(),
      pack: newRecordId(),
      related: newRecordId(),
      relatedIdentity: newRecordId(),
      subject: newRecordId(),
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
      .query(`INSERT INTO doc(id,record_id,scope,subject,slug,title,body,delivery,created_at,updated_at,audiences)
        VALUES (10,?,'global',NULL,'parent','Parent','Parent.','demand','a','a','["technical"]')`)
      .run(ids.parent)
    database
      .query(`INSERT INTO doc(id,record_id,scope,subject,slug,title,body,delivery,created_at,updated_at,audiences,parent_id)
        VALUES (11,?,'global',NULL,'child','Child','Child.','demand','a','a','["technical"]',10)`)
      .run(ids.child)
    database
      .query(`INSERT INTO doc_revision(id,record_id,doc_id,scope,subject,slug,op,title,body,delivery,author,reason,at,audiences)
        VALUES (20,?,10,'global',NULL,'parent','create','Parent','Parent.','demand','tester','seed','a','["technical"]')`)
      .run(ids.parentRevision)
    database
      .query(`INSERT INTO doc_revision(id,record_id,doc_id,scope,subject,slug,op,title,body,delivery,author,reason,at,audiences,parent_id)
        VALUES (21,?,11,'global',NULL,'child','create','Child','Child.','demand','tester','seed','a','["technical"]',10)`)
      .run(ids.childRevision)
    database
      .query(
        'INSERT INTO doc_related_subject(id,record_id,doc_record_id,subject_id) VALUES (?,?,?,?)',
      )
      .run(ids.related, ids.relatedIdentity, ids.child, ids.subject)
    database
      .query(`INSERT INTO canon_pack(id,record_id,job,project,sha256,bytes,doc_count,doc_revisions,compiled_at,findings)
        VALUES (30,?,'fixture',NULL,'sha',1,1,?,'a',0)`)
      .run(ids.pack, JSON.stringify([{ revisionId: 21 }]))

    const before = new Map(TABLES.map((table) => [table, count(database, table)]))
    expect(applyMigrations(database)).toContain('0130_doc_uuid_key')
    for (const [table, rows] of before) expect(count(database, table), table).toBe(rows)
    expect(
      database.query('SELECT record_id,parent_record_id FROM doc WHERE record_id=?').get(ids.child),
    ).toEqual({
      record_id: ids.child,
      parent_record_id: ids.parent,
    })
    expect(
      database
        .query(
          'SELECT record_id,doc_record_id,parent_record_id,number FROM doc_revision WHERE record_id=?',
        )
        .get(ids.childRevision),
    ).toEqual({
      record_id: ids.childRevision,
      doc_record_id: ids.child,
      parent_record_id: ids.parent,
      number: 21,
    })
    expect(database.query('SELECT record_id,doc_record_id FROM doc_related_subject').get()).toEqual(
      {
        record_id: ids.relatedIdentity,
        doc_record_id: ids.child,
      },
    )
    expect(database.query('SELECT record_id,doc_revisions FROM canon_pack').get()).toEqual({
      record_id: ids.pack,
      doc_revisions: JSON.stringify([{ revisionId: ids.childRevision }]),
    })
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    database.close()
  }
})

test('document UUID-key migration keeps removed-document history grouped with a null live reference', () => {
  const database = migrationBoundaryTestDatabase(DOC_UUID_BOUNDARY)
  try {
    for (const [number, op] of [
      [41, 'create'],
      [42, 'set'],
      [43, 'delete'],
    ] as const) {
      database
        .query(`INSERT INTO doc_revision(id,record_id,doc_id,scope,subject,slug,op,title,body,delivery,author,reason,at,audiences)
          VALUES (?,?,999,'project','fixture','removed-history',?,'Removed','Body','demand','tester','seed','a','["technical"]')`)
        .run(number, newRecordId(), op)
    }

    expect(applyMigrations(database)).toContain('0130_doc_uuid_key')
    expect(
      database
        .query(`SELECT scope,subject,slug,COUNT(*) revisions,SUM(doc_record_id IS NULL) detached
          FROM doc_revision WHERE slug='removed-history' GROUP BY scope,subject,slug`)
        .get(),
    ).toEqual({
      scope: 'project',
      subject: 'fixture',
      slug: 'removed-history',
      revisions: 3,
      detached: 3,
    })
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    database.close()
  }
})

test('document UUID-key migration reports every orphan together and leaves the old schema unchanged', () => {
  const database = migrationBoundaryTestDatabase(DOC_UUID_BOUNDARY)
  try {
    database.exec('PRAGMA foreign_keys=OFF')
    const missingRevision = newRecordId()
    database.exec(`
      INSERT INTO doc(id,record_id,scope,subject,slug,title,body,delivery,created_at,updated_at,audiences,parent_id)
      VALUES (1,'01990000-0000-7000-8000-000000000001','global',NULL,'orphan-doc','Doc','Body','demand','a','a','["technical"]',901);
      INSERT INTO doc_revision(id,record_id,doc_id,scope,subject,slug,op,title,body,delivery,author,reason,at,audiences,parent_id)
      VALUES (2,'01990000-0000-7000-8000-000000000002',1,'global',NULL,'orphan-revision','create','Revision','Body','demand','tester','seed','a','["technical"]',903);
      INSERT INTO run(record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,doc_revisions)
      VALUES ('01990000-0000-7000-8000-000000000003',1,'a','codex','test','sha',1,'p','ok','[904]');
      INSERT INTO canon_pack(record_id,job,sha256,bytes,doc_count,doc_revisions,compiled_at,findings)
      VALUES ('01990000-0000-7000-8000-000000000004','test','sha',1,1,'[{"revisionId":905}]','a',0);
      INSERT INTO question(record_id,number,run_record_id,asked_at,question,asked_via,filed_as,filed_ref)
      VALUES ('01990000-0000-7000-8000-000000000005',1,'01990000-0000-7000-8000-000000000003','a','q','reply','doc','999@${missingRevision}');
      INSERT INTO workflow_obligation(cursor_id,step_ordinal,step_slug,floor,reason,session_id,created_at,satisfied_evidence,record_id)
      VALUES (1,0,'step','recorded-artifact','r','s','a','[{"flag":"--artifact","value":"doc:906"}]','01990000-0000-7000-8000-000000000006');
    `)

    expect(() => applyMigrations(database)).toThrow(
      'doc.parent_record_id=1, doc_revision.parent_record_id=1, run.doc_revisions=1, canon_pack.doc_revisions=1, question.filed_ref=1, workflow_obligation.satisfied_evidence=1',
    )
    expect(database.query("SELECT name FROM pragma_table_info('doc')").all()).toContainEqual({
      name: 'id',
    })
    expect(
      database.query("SELECT name FROM pragma_table_info('doc_revision')").all(),
    ).toContainEqual({ name: 'doc_id' })
    expect(count(database, 'doc')).toBe(1)
    expect(count(database, 'doc_revision')).toBe(1)
  } finally {
    database.close()
  }
})

test('document UUID-key migration refuses an ambiguous bare run and document number', () => {
  const database = migrationBoundaryTestDatabase(DOC_UUID_BOUNDARY)
  try {
    database.exec(`
      INSERT INTO project(record_id,name,path,canon,settings) VALUES ('01990000-0000-7000-8000-000000000070','other','/other',1,'{}');
      INSERT INTO workflow_cursor(id,project,workflow_slug,mode_slug,instance_id,workflow_version,catalogue_version,args,total_steps,created_at,updated_at,record_id)
      VALUES (999,'other','flow','mode','instance',1,1,'{}',1,'a','a','01990000-0000-7000-8000-000000000074');
      INSERT INTO run(record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
      VALUES ('01990000-0000-7000-8000-000000000071',77,'a','codex','test','sha',1,'p','ok');
      INSERT INTO doc(id,record_id,scope,subject,slug,title,body,delivery,created_at,updated_at,audiences,project_record_id)
      VALUES (77,'01990000-0000-7000-8000-000000000072','project','other','later-doc','Doc','Body','demand','a','a','["technical"]','01990000-0000-7000-8000-000000000070');
      INSERT INTO workflow_obligation(cursor_id,step_ordinal,step_slug,floor,reason,session_id,created_at,satisfied_evidence,record_id)
      VALUES (999,0,'step','recorded-artifact','r','s','a','[{"flag":"--artifact","value":"77"}]','01990000-0000-7000-8000-000000000073');
    `)
    expect(() => applyMigrations(database)).toThrow(
      'workflow_obligation.satisfied_evidence.ambiguous=1',
    )
    expect(database.query("SELECT name FROM pragma_table_info('doc')").all()).toContainEqual({
      name: 'id',
    })
  } finally {
    database.close()
  }
})

test('document UUID-key migration preserves a path-shaped canon artifact address', () => {
  const database = migrationBoundaryTestDatabase(DOC_UUID_BOUNDARY)
  try {
    database.exec(`
      INSERT INTO workflow_cursor(id,project,workflow_slug,mode_slug,instance_id,workflow_version,catalogue_version,args,total_steps,created_at,updated_at,record_id)
      VALUES (999,'fixture','flow','mode','instance',1,1,'{}',1,'a','a','01990000-0000-7000-8000-000000000087');
      INSERT INTO doc(id,record_id,scope,subject,slug,title,body,delivery,created_at,updated_at,audiences)
      VALUES (88,'01990000-0000-7000-8000-000000000088','canon','fixture','.agents/rules/10-code.md','Doc','Body','inject','a','a','["technical"]');
      INSERT INTO workflow_obligation(cursor_id,step_ordinal,step_slug,floor,reason,session_id,created_at,satisfied_evidence,record_id)
      VALUES (999,0,'step','recorded-artifact','r','s','a','[{"flag":"--artifact","value":"doc:88"}]','01990000-0000-7000-8000-000000000089');
    `)
    expect(applyMigrations(database)).toContain('0130_doc_uuid_key')
    expect(
      database
        .query('SELECT satisfied_evidence FROM workflow_obligation WHERE record_id=?')
        .get('01990000-0000-7000-8000-000000000089'),
    ).toEqual({
      satisfied_evidence:
        '[{"flag":"--artifact","value":"doc:canon/fixture/.agents/rules/10-code.md"}]',
    })
  } finally {
    database.close()
  }
})
