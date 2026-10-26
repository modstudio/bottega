import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

const ROOT = '00000000-0000-4000-8000-000000000042'
const TURN = '00000000-0000-4000-8000-000000000043'
const CURSOR = '00000000-0000-4000-8000-000000000044'

function migratedBeforeQuestionRunRecordId() {
  const folder = mkdtempSync(join(tmpdir(), 'hub-question-run-record-id-'))
  mkdirSync(join(folder, 'meta'))
  const entries = migrationJournal().slice(0, 42)
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

test('question run refs migrate to UUID columns while workflow questions and constraints survive', () => {
  const d = migratedBeforeQuestionRunRecordId()
  try {
    d.exec(`
      INSERT INTO question(record_id,number,run_ref,root_ref,asked_at)
      VALUES ('run-question',1,'orch:${ROOT}:turn:${TURN}','orch:${ROOT}','2026-10-26');
      INSERT INTO question(record_id,number,workflow_cursor_id,workflow_key,asked_at)
      VALUES ('workflow-question',2,'${CURSOR}','DEV-1775','2026-10-26');
      INSERT INTO question_delivery(question_record_id,run_ref,mode,outcome,at)
      VALUES ('run-question','orch:${ROOT}:turn:${TURN}','resume','delivered','2026-10-26');
      INSERT INTO operator_waiting_email(kind,question_record_id,episode,pushed_at)
      VALUES ('question','run-question','episode','2026-10-26');
      INSERT INTO question(record_id,number,run_ref,root_ref,asked_at)
      VALUES ('root-only-question',3,'orch:${CURSOR}','orch:${CURSOR}','2026-10-26');
      INSERT INTO question_delivery(question_record_id,run_ref,mode,outcome,at)
      VALUES ('root-only-question','orch:${CURSOR}','live','delivered','2026-10-26');
    `)

    expect(applyMigrations(d, undefined, HUB_MIGRATION_BACKFILL_VALUES)).toContain(
      '0042_question_run_record_id',
    )
    expect(
      d
        .query(
          `SELECT record_id,run_record_id,root_run_record_id,workflow_cursor_id
           FROM question ORDER BY number`,
        )
        .all(),
    ).toEqual([
      {
        record_id: 'run-question',
        run_record_id: TURN,
        root_run_record_id: ROOT,
        workflow_cursor_id: null,
      },
      {
        record_id: 'workflow-question',
        run_record_id: null,
        root_run_record_id: null,
        workflow_cursor_id: CURSOR,
      },
      {
        record_id: 'root-only-question',
        run_record_id: CURSOR,
        root_run_record_id: CURSOR,
        workflow_cursor_id: null,
      },
    ])
    expect(
      d.query('SELECT run_record_id FROM question_delivery ORDER BY question_record_id').all(),
    ).toEqual([{ run_record_id: CURSOR }, { run_record_id: TURN }])
    expect(d.query('SELECT question_record_id FROM operator_waiting_email').get()).toEqual({
      question_record_id: 'run-question',
    })
    expect(() =>
      d
        .query(`INSERT INTO question(record_id,number,asked_at) VALUES ('neither',3,'2026-10-26')`)
        .run(),
    ).toThrow()
  } finally {
    d.close()
  }
})

const GOOD_RUN_REF = `orch:${ROOT}:turn:${TURN}`
const UNPARSEABLE_CASES = [
  {
    column: 'question.run_ref',
    runRef: 'not-an-orchestrator-ref',
    rootRef: `orch:${ROOT}`,
    deliveryRef: GOOD_RUN_REF,
  },
  {
    column: 'question.root_ref',
    runRef: GOOD_RUN_REF,
    rootRef: `orch:${ROOT}:turn:${TURN}`,
    deliveryRef: GOOD_RUN_REF,
  },
  {
    column: 'question_delivery.run_ref',
    runRef: GOOD_RUN_REF,
    rootRef: `orch:${ROOT}`,
    deliveryRef: 'orch:17:turn:18',
  },
]

for (const bad of UNPARSEABLE_CASES) {
  test(`question run-ref migration aborts before dropping an unparseable ${bad.column}`, () => {
    const d = migratedBeforeQuestionRunRecordId()
    try {
      d.query(
        `INSERT INTO question(record_id,number,run_ref,root_ref,asked_at)
         VALUES ('bad-question',1,?,?,'2026-10-26')`,
      ).run(bad.runRef, bad.rootRef)
      d.query(
        `INSERT INTO question_delivery(question_record_id,run_ref,mode,outcome,at)
         VALUES ('bad-question',?,'resume','delivered','2026-10-26')`,
      ).run(bad.deliveryRef)

      expect(() => applyMigrations(d, undefined, HUB_MIGRATION_BACKFILL_VALUES)).toThrow(
        `unparseable ${bad.column} values`,
      )
      expect(
        d.query(`SELECT run_ref,root_ref FROM question WHERE record_id='bad-question'`).get(),
      ).toEqual({ run_ref: bad.runRef, root_ref: bad.rootRef })
      expect(
        d
          .query<{ count: number }, []>(
            `SELECT COUNT(*) count FROM pragma_table_info('question') WHERE name='run_record_id'`,
          )
          .get(),
      ).toEqual({ count: 0 })
    } finally {
      d.close()
    }
  })
}
