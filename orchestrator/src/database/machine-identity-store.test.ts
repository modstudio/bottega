import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_HOME_ENV } from '../../../shared/config-directory.ts'
import { storedMachineId } from '../../../shared/machine-config.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { backfillLandingEvidenceRecords } from '../record/landing-outbox.ts'
import { startReleaseLedgerEntry } from '../release/release-ledger.ts'
import { enqueueReview } from '../review/review-outbox.ts'
import { enqueueQuestionRecord } from '../run/question-outbox.ts'
import { carryMachineIdentity, machineIdStored } from './machine-identity-store.ts'
import { applyMigrations } from './migrations.ts'

test('an orchestrator identity is carried to shared configuration once', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-carry-'))
  const database = new Database(':memory:')
  try {
    database.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const id = '01990000-0000-7000-8000-000000001240'
    database.query("INSERT INTO schema_meta VALUES ('machine_id', ?)").run(id)
    const env = { HOME: root, [CONFIG_HOME_ENV]: join(root, 'config') }
    expect(carryMachineIdentity(database, (fn) => database.transaction(fn).immediate(), env)).toBe(
      id,
    )
    expect(machineIdStored(database)).toBe(id)
    expect(storedMachineId(env)).toBe(id)
    expect(carryMachineIdentity(database, (fn) => database.transaction(fn).immediate(), env)).toBe(
      id,
    )
  } finally {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a stale orchestrator identity is replaced by shared configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-carry-stale-'))
  const database = new Database(':memory:')
  try {
    database.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const shared = '01990000-0000-7000-8000-000000001240'
    const stale = '01990000-0000-7000-8000-000000001241'
    const env = { HOME: root, [CONFIG_HOME_ENV]: join(root, 'config') }
    database.query("INSERT INTO schema_meta VALUES ('machine_id', ?)").run(shared)
    expect(carryMachineIdentity(database, (fn) => database.transaction(fn).immediate(), env)).toBe(
      shared,
    )
    database.query("INSERT OR REPLACE INTO schema_meta VALUES ('machine_id', ?)").run(stale)
    expect(carryMachineIdentity(database, (fn) => database.transaction(fn).immediate(), env)).toBe(
      shared,
    )
    expect(machineIdStored(database)).toBe(shared)
  } finally {
    database.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('all evidence enqueue paths use the shared id and preserve its legacy key', () => {
  const root = mkdtempSync(join(tmpdir(), 'machine-enqueue-'))
  const prior = process.env[CONFIG_HOME_ENV]
  process.env[CONFIG_HOME_ENV] = join(root, 'config')
  const database = new Database(':memory:')
  applyMigrations(database)
  try {
    const shared = '01990000-0000-7000-8000-000000001240'
    database.query("INSERT INTO schema_meta(key,value) VALUES ('machine_id',?)").run(shared)
    expect(carryMachineIdentity(database, (fn) => database.transaction(fn).immediate())).toBe(
      shared,
    )
    database.exec(`
      INSERT INTO run
        (number,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
      VALUES
        (1,'01990000-0000-7000-8000-000000001251','2026-10-12T10:00:00Z',
         'codex','implementation','sha',1,'prompt','asking');
      INSERT INTO question (number,record_id,run_record_id,asked_at,question)
      VALUES (1,'${newRecordId()}','01990000-0000-7000-8000-000000001251','2026-10-12T10:01:00Z','Which?');
      INSERT INTO review (number,record_id,recorded_at)
      VALUES (1,'01990000-0000-7000-8000-000000001252','2026-10-12T10:02:00Z');
      INSERT INTO landing (record_id,project,branch,status,started_at)
      VALUES ('01990000-0000-7000-8000-000000001253','fixture','DEV-1240','landed',
              '2026-10-12T10:03:00Z');
    `)
    startReleaseLedgerEntry(database, {
      project: 'fixture',
      rung: 'production',
      candidate: 'candidate',
      live: 'before',
      rollback: false,
      reason: null,
    })
    const questionRecordId = (
      database.query('SELECT record_id FROM question').get() as { record_id: string }
    ).record_id
    enqueueQuestionRecord(database, questionRecordId)
    enqueueReview(database, '01990000-0000-7000-8000-000000001252')
    backfillLandingEvidenceRecords(database)

    const payloads = database
      .query<{ kind: string; payload: string }, []>(
        "SELECT kind,payload FROM outbox WHERE kind IN ('release','question','review','landing') ORDER BY kind",
      )
      .all()
    expect(payloads.map((row) => row.kind)).toEqual(['landing', 'question', 'release', 'review'])
    expect(payloads.map((row) => JSON.parse(row.payload).machineId)).toEqual([
      shared,
      shared,
      shared,
      shared,
    ])
    expect(machineIdStored(database)).toBe(shared)
  } finally {
    database.close()
    if (prior === undefined) delete process.env[CONFIG_HOME_ENV]
    else process.env[CONFIG_HOME_ENV] = prior
    rmSync(root, { recursive: true, force: true })
  }
})
