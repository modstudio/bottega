import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

function storeBeforeDayHostedSpace() {
  const folder = mkdtempSync(join(tmpdir(), 'hub-day-hosted-space-migration-'))
  mkdirSync(join(folder, 'meta'))
  const entries = migrationJournal().slice(0, -1)
  for (const entry of entries)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries }),
  )
  const database = new Database(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  applyMigrations(database, folder, {
    machine_id: '01990000-0000-7000-8000-000000008204',
  })
  rmSync(folder, { recursive: true, force: true })
  return database
}

test('day hosted-space migration records the old destination and requeues pushed history', () => {
  const database = storeBeforeDayHostedSpace()
  const day = '01990000-0000-7000-8000-000000008203'
  database
    .query(
      `INSERT INTO install_binding(id,bound,active_space_id,bound_at)
       VALUES (1,1,'space-old','2026-10-11T12:00:00.000Z')`,
    )
    .run()
  database
    .query(`INSERT INTO day(record_id,day,collected_at) VALUES (?,'2026-10-11',?)`)
    .run(day, '2026-10-11T23:00:00.000Z')
  database.query(`DELETE FROM hosted_outbox WHERE table_name='hub_day'`).run()

  applyMigrations(database, undefined, {
    machine_id: '01990000-0000-7000-8000-000000008204',
  })

  expect(database.query(`SELECT hosted_space_id FROM day WHERE record_id=?`).get(day)).toEqual({
    hosted_space_id: 'space-old',
  })
  expect(
    database
      .query(
        `SELECT table_name,row_id,operation,routing_space_id,generation
         FROM hosted_outbox WHERE row_id=?`,
      )
      .get(day),
  ).toEqual({
    table_name: 'hub_day',
    row_id: day,
    operation: 'upsert',
    routing_space_id: null,
    generation: 2,
  })
  database.close()
})
