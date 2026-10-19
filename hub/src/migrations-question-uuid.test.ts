import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import { questionIdentitiesForMigrations } from './db.ts'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

const migratedThrough = (lastIndex: number) => {
  const folder = mkdtempSync(join(tmpdir(), 'hub-question-migration-stage-'))
  mkdirSync(join(folder, 'meta'))
  const entries = migrationJournal().slice(0, lastIndex + 1)
  for (const entry of entries)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
  )
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  applyMigrations(database, folder, HUB_MIGRATION_BACKFILL_VALUES)
  rmSync(folder, { recursive: true, force: true })
  return database
}

describe('Hub question UUID migration', () => {
  test('reads the orchestrator map only when the question rekey is pending', async () => {
    const current = migratedThrough(36)
    const pending = migratedThrough(35)
    let calls = 0
    const readMap = async () => {
      calls++
      return []
    }
    try {
      expect(await questionIdentitiesForMigrations(current, readMap)).toEqual([])
      expect(calls).toBe(0)
      expect(await questionIdentitiesForMigrations(pending, readMap)).toEqual([])
      expect(calls).toBe(1)
    } finally {
      current.close()
      pending.close()
    }
  })

  test('a pending rekey names machine migrate when the orchestrator map is unavailable', async () => {
    const pending = migratedThrough(35)
    try {
      await expect(
        questionIdentitiesForMigrations(pending, async () => {
          throw new Error('orchestrator unavailable')
        }),
      ).rejects.toThrow(`run ${PLATFORM_SLUG} machine migrate`)
    } finally {
      pending.close()
    }
  })

  test('uses the declared orchestrator map and preserves local children', () => {
    const d = migratedThrough(35)
    try {
      d.exec(`
        INSERT INTO question(question_id,run_ref,root_ref,task_key,session_id,asked_at)
        VALUES (91,'orch:run','orch:run','DEV-1214','session','2026-10-19');
        INSERT INTO question_delivery(question_id,run_ref,mode,outcome,at)
        VALUES (91,'orch:run','resume','delivered','2026-10-19');
        INSERT INTO operator_waiting_email(kind,item_id,episode,pushed_at)
        VALUES ('question',91,'episode','2026-10-19');
      `)
      const recordId = '01990000-0000-7000-8000-000000000091'
      expect(
        applyMigrations(d, undefined, HUB_MIGRATION_BACKFILL_VALUES, [
          { number: 91, record_id: recordId },
        ]),
      ).toEqual(['0036_question_uuid_key'])
      expect(d.query('SELECT record_id,number FROM question').get()).toEqual({
        record_id: recordId,
        number: 91,
      })
      expect(d.query('SELECT question_record_id FROM question_delivery').get()).toEqual({
        question_record_id: recordId,
      })
      expect(d.query('SELECT question_record_id FROM operator_waiting_email').get()).toEqual({
        question_record_id: recordId,
      })
      expect(d.query('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      d.close()
    }
  })

  test('refuses an unavailable or incomplete map without changing schema', () => {
    const d = migratedThrough(35)
    try {
      d.query(
        `INSERT INTO question(question_id,run_ref,root_ref,task_key,session_id,asked_at)
         VALUES (92,'orch:run','orch:run','DEV-1214','session','2026-10-19')`,
      ).run()
      expect(() => applyMigrations(d)).toThrow(
        'orchestrator identity map is missing Hub question numbers question [92]',
      )
      expect(
        d.query("SELECT name FROM pragma_table_info('question') ORDER BY cid").all(),
      ).toContainEqual({ name: 'question_id' })
      expect(d.query('SELECT COUNT(*) count FROM question').get()).toEqual({ count: 1 })
    } finally {
      d.close()
    }
  })

  test('refuses an unmapped delivery without changing schema or rows', () => {
    const d = migratedThrough(35)
    try {
      d.exec(`
        INSERT INTO question(question_id,run_ref,root_ref,task_key,session_id,asked_at)
        VALUES (92,'orch:run','orch:run','DEV-1214','session','2026-10-19');
        PRAGMA foreign_keys=OFF;
        INSERT INTO question_delivery(question_id,run_ref,mode,outcome,at)
        VALUES (93,'orch:run','resume','delivered','2026-10-19');
      `)
      expect(() =>
        applyMigrations(d, undefined, HUB_MIGRATION_BACKFILL_VALUES, [
          { number: 92, record_id: '01990000-0000-7000-8000-000000000092' },
        ]),
      ).toThrow('question_delivery [93]')
      expect(
        d.query("SELECT name FROM pragma_table_info('question_delivery') ORDER BY cid").all(),
      ).toContainEqual({ name: 'question_id' })
      expect(d.query('SELECT question_id FROM question_delivery').all()).toEqual([
        { question_id: 93 },
      ])
    } finally {
      d.close()
    }
  })
})
