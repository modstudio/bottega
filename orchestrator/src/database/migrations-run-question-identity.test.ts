import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyMigrations,
  canonicalSchemaHash,
  expectedSchemaHash,
  MIGRATIONS_FOLDER,
  migrationJournal,
} from './migrations.ts'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('run and question identity migration fills nulls, keeps identities, and preserves schema', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-run-question-identity-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const migration = journal.findIndex((entry) => entry.tag === '0104_run_question_record_identity')
  const prior = journal.slice(0, migration)
  for (const entry of prior)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = new Database(':memory:')
  try {
    database.exec('PRAGMA foreign_keys=ON')
    applyMigrations(database, folder)
    const runInsert = database.query(
      `INSERT INTO run
       (record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (?,'2026-10-13','codex','implement','sha',1,'prompt','asking') RETURNING id`,
    )
    const missingRun = runInsert.get(null) as { id: number }
    const keptRunId = '01990000-0000-7000-8000-000000000401'
    const keptRun = runInsert.get(keptRunId) as { id: number }
    database
      .query('UPDATE run SET parent_run_id=?,turn=2 WHERE id=?')
      .run(missingRun.id, keptRun.id)
    const questionInsert = database.query(
      `INSERT INTO question (record_id,run_id,asked_at,question) VALUES (?,?,'2026-10-13',?)
       RETURNING id`,
    )
    const missingQuestion = questionInsert.get(null, missingRun.id, 'Missing?') as { id: number }
    const keptQuestionId = '01990000-0000-7000-8000-000000000402'
    const keptQuestion = questionInsert.get(keptQuestionId, keptRun.id, 'Kept?') as { id: number }
    database
      .query(
        `INSERT INTO run_checkpoint
         (run_id,checkpoint_no,commit_sha,task_pointer,final,created_at)
         VALUES (?,1,'abc','migration',0,'2026-10-13')`,
      )
      .run(missingRun.id)
    database
      .query(
        `INSERT INTO question_delivery (question_id,run_id,mode,outcome,at,error)
         VALUES (?,?,'resume','delivered','2026-10-13',NULL)`,
      )
      .run(missingQuestion.id, missingRun.id)

    expect(applyMigrations(database)).toEqual([
      '0104_run_question_record_identity',
      '0105_doc_checked_against_commit',
      '0106_review_landing_release_doc_record_identity',
      '0107_score_gate_claim_audit_record_identity',
      '0108_workflow_lens_port_record_identity',
      '0109_remaining_store_record_identity',
    ])
    const runIds = database
      .query<{ id: number; record_id: string }, []>('SELECT id,record_id FROM run ORDER BY id')
      .all()
    const questionIds = database
      .query<{ id: number; record_id: string }, []>('SELECT id,record_id FROM question ORDER BY id')
      .all()
    expect(runIds.find((row) => row.id === missingRun.id)?.record_id).toMatch(UUID_V4)
    expect(runIds.find((row) => row.id === keptRun.id)?.record_id).toBe(keptRunId)
    expect(database.query('SELECT parent_run_id,turn FROM run WHERE id=?').get(keptRun.id)).toEqual(
      { parent_run_id: missingRun.id, turn: 2 },
    )
    expect(questionIds.find((row) => row.id === missingQuestion.id)?.record_id).toMatch(UUID_V4)
    expect(questionIds.find((row) => row.id === keptQuestion.id)?.record_id).toBe(keptQuestionId)
    expect(database.query('SELECT run_id FROM run_checkpoint').get()).toEqual({
      run_id: missingRun.id,
    })
    expect(database.query('SELECT question_id,run_id FROM question_delivery').get()).toEqual({
      question_id: missingQuestion.id,
      run_id: missingRun.id,
    })
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
    const fresh = new Database(':memory:')
    fresh.exec('PRAGMA foreign_keys=ON')
    applyMigrations(fresh)
    const schemaRows = (subject: Database) =>
      subject
        .query(
          `SELECT type,name,tbl_name,sql FROM sqlite_master
           WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`,
        )
        .all()
    expect(schemaRows(database)).toEqual(schemaRows(fresh))
    expect(canonicalSchemaHash(database)).toBe(canonicalSchemaHash(fresh))
    fresh.close()
    expect(canonicalSchemaHash(database)).toBe(expectedSchemaHash())
  } finally {
    database.close()
    rmSync(folder, { recursive: true, force: true })
  }
})
