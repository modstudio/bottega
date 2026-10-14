import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations, MIGRATIONS_FOLDER, migrationJournal } from './migrations.ts'

test('board reach heartbeat migration preserves rows and emission uniqueness', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orch-board-reach-heartbeat-'))
  mkdirSync(join(folder, 'meta'))
  const journal = migrationJournal()
  const migration = journal.findIndex((entry) => entry.tag === '0102_board_reach_heartbeat')
  const prior = journal.slice(0, migration)
  for (const entry of prior)
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'sqlite', entries: prior }),
  )
  const database = new Database(':memory:')
  try {
    applyMigrations(database, folder)
    database
      .query(
        `INSERT INTO board_reach_delivery
         (message_source,message_id,reader_session,reader_project,delivery_point,blocked_stop,
          audience,acknowledgement_required,posted_at,expires_at,session_started_at,
          posting_timing,concern,recorded_at,emission_id)
         VALUES ('hosted','message-1','reader-1','project-1','stop',1,'architects',1,
          '2026-10-13T10:00:00.000Z','2026-10-14T10:00:00.000Z',
          '2026-10-13T09:00:00.000Z','after-session','concerned',
          '2026-10-13T10:01:00.000Z','emission-1')`,
      )
      .run()
    expect(applyMigrations(database)).toEqual([
      '0102_board_reach_heartbeat',
      '0103_board_message_purpose',
      '0104_run_question_record_identity',
      '0105_doc_checked_against_commit',
      '0106_review_landing_release_doc_record_identity',
    ])
    expect(database.query('SELECT * FROM board_reach_delivery').get()).toEqual({
      id: 1,
      message_source: 'hosted',
      message_id: 'message-1',
      reader_session: 'reader-1',
      reader_project: 'project-1',
      delivery_point: 'stop',
      blocked_stop: 1,
      audience: 'architects',
      acknowledgement_required: 1,
      purpose: 'information',
      posted_at: '2026-10-13T10:00:00.000Z',
      expires_at: '2026-10-14T10:00:00.000Z',
      session_started_at: '2026-10-13T09:00:00.000Z',
      posting_timing: 'after-session',
      concern: 'concerned',
      recorded_at: '2026-10-13T10:01:00.000Z',
      emission_id: 'emission-1',
    })
    const insert = database.query(
      `INSERT INTO board_reach_delivery
       (message_source,message_id,reader_session,reader_project,delivery_point,blocked_stop,
        audience,acknowledgement_required,posted_at,session_started_at,posting_timing,concern,
        recorded_at,emission_id)
       VALUES ('hosted','message-1','reader-2','project-2','heartbeat-monitor',0,
        'architects',0,'2026-10-13T10:02:00.000Z','2026-10-13T09:00:00.000Z',
        'after-session','not-concerned','2026-10-13T10:03:00.000Z',?)`,
    )
    expect(() => insert.run('emission-1')).toThrow()
    insert.run(null)
    insert.run(null)
    expect(
      database
        .query('SELECT COUNT(*) count FROM board_reach_delivery WHERE emission_id IS NULL')
        .get(),
    ).toEqual({ count: 2 })
  } finally {
    database.close()
    rmSync(folder, { recursive: true, force: true })
  }
})
