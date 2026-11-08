import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insertRun } from '../../test/fixtures/run-answer.ts'
import { db } from '../database/db.ts'
import { GOOSE_LEDGER_KEEP_DAYS } from '../run/run-artifact-limits.ts'
import {
  decideGooseLedgerSweep,
  removeAfterExtraction,
  sweepGooseLedgers,
} from './goose-ledger-sweep.ts'

const expired = {
  olderThanWindow: true,
  walkComplete: true,
  rowExists: true,
  rowTerminal: true,
  profilePresent: false,
}

test('expired Goose ledgers of finished runs extract only when the run profile is absent', () => {
  expect(decideGooseLedgerSweep(expired)).toBe('extract-remove')
  expect(decideGooseLedgerSweep({ ...expired, profilePresent: true })).toBe('remove')
  expect(decideGooseLedgerSweep({ ...expired, rowExists: false, rowTerminal: false })).toBe(
    'remove',
  )
})

test('Goose ledgers stay while recent, unmeasured, or owned by an unfinished run', () => {
  expect(decideGooseLedgerSweep({ ...expired, olderThanWindow: false })).toBe('keep')
  expect(decideGooseLedgerSweep({ ...expired, walkComplete: false })).toBe('keep')
  expect(decideGooseLedgerSweep({ ...expired, rowTerminal: false })).toBe('keep')
})

test('a ledger whose sources yield no profile is kept, one with no sources is removed', () => {
  expect(removeAfterExtraction({ profileFound: false, sourcePresent: true })).toBe(false)
  expect(removeAfterExtraction({ profileFound: false, sourcePresent: false })).toBe(true)
  expect(removeAfterExtraction({ profileFound: true, sourcePresent: true })).toBe(true)
})

test('the sweep records a profile before removing a copy and keeps a copy it cannot read', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'goose-ledger-sweep-'))
  try {
    const readable = insertRun('ok')
    const unreadable = insertRun('ok')
    const request = { input: { messages: [{ role: 'system', content: 'agent' }], tools: [{}] } }
    for (const [id, line] of [
      [readable, JSON.stringify(request)],
      [unreadable, '{not json'],
    ] as const) {
      mkdirSync(join(runsDir, id, 'goose', 'logs'), { recursive: true })
      writeFileSync(join(runsDir, id, 'goose', 'logs', 'llm_request.0.jsonl'), `${line}\n`)
    }
    const later = Date.now() + (GOOSE_LEDGER_KEEP_DAYS + 1) * 86_400_000

    expect(sweepGooseLedgers({ dryRun: false, runsDir, database: db() }).removed).toBe(0)
    const swept = sweepGooseLedgers({ dryRun: false, runsDir, database: db(), now: later })

    expect(swept).toMatchObject({ removed: 1, extracted: 1, failed: 1 })
    expect(existsSync(join(runsDir, readable, 'goose'))).toBe(false)
    expect(existsSync(join(runsDir, unreadable, 'goose'))).toBe(true)
    expect(
      db().query('SELECT context_system_chars AS chars FROM run WHERE record_id=?').get(readable),
    ).toEqual({ chars: 5 })
    expect(
      db().query("SELECT COUNT(*) AS n FROM outbox WHERE kind='run' AND row_id=?").get(readable),
    ).toEqual({ n: 1 })
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
  }
})

test('the sweep ages a copy by content when a reader rewrites its shared-memory index', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'goose-ledger-sweep-'))
  try {
    const runId = insertRun('ok')
    db().query('UPDATE run SET context_system_chars=1 WHERE record_id=?').run(runId)
    const gooseDir = join(runsDir, runId, 'goose')
    const sessionsDir = join(gooseDir, 'sessions')
    const databasePath = join(sessionsDir, 'sessions.db')
    const walPath = `${databasePath}-wal`
    const sharedMemoryPath = `${databasePath}-shm`
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(databasePath, 'content')
    writeFileSync(walPath, 'content')
    writeFileSync(sharedMemoryPath, 'index')
    const now = Date.now()
    const old = new Date(now - (GOOSE_LEDGER_KEEP_DAYS + 1) * 86_400_000)
    for (const path of [databasePath, walPath, sessionsDir, gooseDir]) utimesSync(path, old, old)
    utimesSync(sharedMemoryPath, new Date(now), new Date(now))

    expect(sweepGooseLedgers({ dryRun: false, runsDir, database: db(), now })).toMatchObject({
      removed: 1,
      failed: 0,
    })
    expect(existsSync(gooseDir)).toBe(false)
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
  }
})
