import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

function migratedBeforeQuestionCommitTaskLink() {
  const folder = mkdtempSync(join(tmpdir(), 'hub-question-commit-task-link-'))
  mkdirSync(join(folder, 'meta'))
  const entries = migrationJournal().slice(0, 41)
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

test('question and commit task links backfill only exact unique keys', () => {
  const d = migratedBeforeQuestionCommitTaskLink()
  try {
    d.exec(`
      INSERT INTO task(record_id,key,project,source,first_seen,last_seen) VALUES
        ('task-match','MATCH-1','alpha','local','2026-10-25','2026-10-25'),
        ('task-dup-a','DUP-1','alpha','local','2026-10-25','2026-10-25'),
        ('task-dup-b','DUP-1','beta','local','2026-10-25','2026-10-25');
      INSERT INTO question(record_id,number,run_ref,task_key,workflow_key,asked_at) VALUES
        ('question-match',1,'orch:match','MATCH-1','MATCH-1','2026-10-25'),
        ('question-missing',2,'orch:missing','MISSING-1','MISSING-1','2026-10-25'),
        ('question-duplicate',3,'orch:duplicate','DUP-1','DUP-1','2026-10-25');
      INSERT INTO commit_key(sha,repo,task_key,at) VALUES
        ('commit-match','alpha','MATCH-1','2026-10-25'),
        ('commit-missing','alpha','MISSING-1','2026-10-25'),
        ('commit-duplicate','alpha','DUP-1','2026-10-25');
    `)

    expect(applyMigrations(d, undefined, HUB_MIGRATION_BACKFILL_VALUES)).toContain(
      '0041_question_commit_task_record_id',
    )
    expect(
      d
        .query(
          `SELECT record_id,task_record_id,workflow_task_record_id
         FROM question ORDER BY record_id`,
        )
        .all(),
    ).toEqual([
      {
        record_id: 'question-duplicate',
        task_record_id: null,
        workflow_task_record_id: null,
      },
      {
        record_id: 'question-match',
        task_record_id: 'task-match',
        workflow_task_record_id: 'task-match',
      },
      { record_id: 'question-missing', task_record_id: null, workflow_task_record_id: null },
    ])
    expect(d.query(`SELECT sha,task_record_id FROM commit_key ORDER BY sha`).all()).toEqual([
      { sha: 'commit-duplicate', task_record_id: null },
      { sha: 'commit-match', task_record_id: 'task-match' },
      { sha: 'commit-missing', task_record_id: null },
    ])
  } finally {
    d.close()
  }
})

test('late tasks link rows and task deletion clears links without deleting evidence', () => {
  const d = migratedBeforeQuestionCommitTaskLink()
  try {
    applyMigrations(d, undefined, HUB_MIGRATION_BACKFILL_VALUES)
    d.exec(`
      INSERT INTO question(record_id,number,run_ref,task_key,workflow_key,asked_at)
      VALUES ('question-late',1,'orch:late','LATE-1','LATE-1','2026-10-25');
      INSERT INTO commit_key(sha,repo,task_key,at)
      VALUES ('commit-late','alpha','LATE-1','2026-10-25');
      INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
      VALUES ('task-late','LATE-1','alpha','local','2026-10-25','2026-10-25');
    `)
    expect(
      d
        .query(
          `SELECT task_record_id,workflow_task_record_id FROM question WHERE record_id='question-late'`,
        )
        .get(),
    ).toEqual({ task_record_id: 'task-late', workflow_task_record_id: 'task-late' })
    expect(d.query(`SELECT task_record_id FROM commit_key WHERE sha='commit-late'`).get()).toEqual({
      task_record_id: 'task-late',
    })

    d.exec(`
      INSERT INTO task(record_id,key,project,source,first_seen,last_seen) VALUES
        ('task-ambiguous-a','AMBIGUOUS-1','alpha','local','2026-10-25','2026-10-25'),
        ('task-ambiguous-b','AMBIGUOUS-1','beta','local','2026-10-25','2026-10-25');
      INSERT INTO question(record_id,number,run_ref,task_key,workflow_key,asked_at)
      VALUES ('question-ambiguous',2,'orch:ambiguous','AMBIGUOUS-1','AMBIGUOUS-1','2026-10-25');
      INSERT INTO commit_key(sha,repo,task_key,at)
      VALUES ('commit-ambiguous','alpha','AMBIGUOUS-1','2026-10-25');
      INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
      VALUES ('task-ambiguous-c','AMBIGUOUS-1','gamma','local','2026-10-25','2026-10-25');
    `)
    expect(
      d
        .query(
          `SELECT task_record_id,workflow_task_record_id FROM question WHERE record_id='question-ambiguous'`,
        )
        .get(),
    ).toEqual({ task_record_id: null, workflow_task_record_id: null })
    expect(
      d.query(`SELECT task_record_id FROM commit_key WHERE sha='commit-ambiguous'`).get(),
    ).toEqual({ task_record_id: null })

    d.exec(`DELETE FROM task WHERE record_id='task-late'`)
    expect(
      d
        .query(
          `SELECT task_record_id,workflow_task_record_id FROM question WHERE record_id='question-late'`,
        )
        .get(),
    ).toEqual({ task_record_id: null, workflow_task_record_id: null })
    expect(d.query(`SELECT task_record_id FROM commit_key WHERE sha='commit-late'`).get()).toEqual({
      task_record_id: null,
    })
  } finally {
    d.close()
  }
})
