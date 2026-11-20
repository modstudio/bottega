import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

function migratedBeforeQuestionSpaceNumber() {
  const folder = mkdtempSync(join(tmpdir(), 'hub-question-space-number-'))
  mkdirSync(join(folder, 'meta'))
  const entries = migrationJournal().slice(0, 50)
  for (const entry of entries)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
  )
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys=ON')
  applyMigrations(database, folder, HUB_MIGRATION_BACKFILL_VALUES)
  rmSync(folder, { recursive: true, force: true })
  return database
}

test('question uniqueness migrates to record space without losing dependents or indexes', () => {
  const database = migratedBeforeQuestionSpaceNumber()
  try {
    database.exec(`
      INSERT INTO question(record_id,number,run_record_id,root_run_record_id,asked_at)
      VALUES ('question-existing',17,'run-existing','root-existing','2026-11-19');
      INSERT INTO question_delivery(question_record_id,mode,outcome,at)
      VALUES ('question-existing','record-only','delivered','2026-11-19');
      INSERT INTO operator_waiting_email(kind,question_record_id,episode,pushed_at)
      VALUES ('question','question-existing','episode-existing','2026-11-19');
    `)

    expect(applyMigrations(database, undefined, HUB_MIGRATION_BACKFILL_VALUES)).toContain(
      '0050_question_space_number',
    )
    database.exec(`
      INSERT INTO question(record_id,space_id,number,run_record_id,root_run_record_id,asked_at)
      VALUES
        ('question-space-a','space-a',17,'run-a','root-a','2026-11-19'),
        ('question-space-b','space-b',17,'run-b','root-b','2026-11-19'),
        ('question-legacy-null',NULL,17,'run-null','root-null','2026-11-19');
    `)

    expect(
      database.query('SELECT record_id,space_id,number FROM question ORDER BY record_id').all(),
    ).toEqual([
      { record_id: 'question-existing', space_id: null, number: 17 },
      { record_id: 'question-legacy-null', space_id: null, number: 17 },
      { record_id: 'question-space-a', space_id: 'space-a', number: 17 },
      { record_id: 'question-space-b', space_id: 'space-b', number: 17 },
    ])
    expect(() =>
      database
        .query(
          `INSERT INTO question(record_id,space_id,number,run_record_id,root_run_record_id,asked_at)
           VALUES ('question-space-a-duplicate','space-a',17,'run-a-2','root-a-2','2026-11-19')`,
        )
        .run(),
    ).toThrow()
    expect(database.query('SELECT * FROM question_delivery').all()).toHaveLength(1)
    expect(database.query('SELECT * FROM operator_waiting_email').all()).toHaveLength(1)
    expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
    expect(
      database
        .query<{ name: string }, []>(
          `SELECT name FROM sqlite_master
           WHERE type IN ('index','trigger') AND name IN
             ('question_open','question_root','question_workflow_cursor','question_task_record_id',
              'question_workflow_task_record_id','question_task_key','question_workflow_key',
              'question_delivery_question_record_id_idx','operator_waiting_email_question_record_id_idx',
              'operator_waiting_email_question_episode','operator_waiting_email_workflow_episode',
              'task_link_unlinked_questions_insert')
           ORDER BY name`,
        )
        .all()
        .map(({ name }) => name),
    ).toEqual([
      'operator_waiting_email_question_episode',
      'operator_waiting_email_question_record_id_idx',
      'operator_waiting_email_workflow_episode',
      'question_delivery_question_record_id_idx',
      'question_open',
      'question_root',
      'question_task_key',
      'question_task_record_id',
      'question_workflow_cursor',
      'question_workflow_key',
      'question_workflow_task_record_id',
      'task_link_unlinked_questions_insert',
    ])
  } finally {
    database.close()
  }
})
