import { beforeEach, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db } from '../database/db.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { projectAt } from '../project/projects.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from './board-mode.ts'
import {
  markSessionMessagesDelivered,
  postNotice,
  reapBoardMessagesForInstall,
  recordPresence,
} from './board-service.ts'
import { messageRows } from './board-store.ts'

beforeEach(() => fixtureProjectRecordId(db()))

function postingProjectPath(): string {
  const cwd = resolve(import.meta.dir, '../../..')
  db()
    .query(
      `INSERT OR IGNORE INTO project(record_id,name,path,settings)
       VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'board-guard-fixture',?,'{}')`,
    )
    .run(cwd)
  if (!projectAt(cwd)) throw new Error('board guard test project did not resolve')
  return cwd
}

test('recordPresence skips local queued-claim renewal after hosted adoption', () => {
  const env = {
    CLAUDE_CODE_SESSION_ID: 'hosted-presence',
    BOTTEGA_RECORD_API_URL: 'https://record.test',
  }
  const cwd = postingProjectPath()
  const claim = newRecordId()
  const renewedAt = '2026-10-05T11:00:00.000Z'
  const lapsesAt = '2026-10-05T13:00:00.000Z'
  db()
    .query(
      `INSERT INTO board_claim
       (record_id,project,subject_kind,subject_value,holder_kind,holder_session,duration_ms,taken_at,renewed_at,lapses_at)
       VALUES (?,'board-guard-fixture','queued-task','DEV-QUEUED','architect',?,3600000,?,?,?)`,
    )
    .run(claim, env.CLAUDE_CODE_SESSION_ID, renewedAt, renewedAt, lapsesAt)
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')

  expect(recordPresence(cwd, env, '2026-10-05T12:00:00.000Z')).toBe(true)
  expect(
    db()
      .query('SELECT session_id FROM presence WHERE session_id=?')
      .get(env.CLAUDE_CODE_SESSION_ID),
  ).toEqual({ session_id: env.CLAUDE_CODE_SESSION_ID })
  expect(
    db().query('SELECT renewed_at,lapses_at FROM board_claim WHERE record_id=?').get(claim),
  ).toEqual({ renewed_at: renewedAt, lapses_at: lapsesAt })
})

test('the install sweep still prunes the hosted cache after adoption', () => {
  const expired = {
    id: newRecordId(),
    kind: 'notice',
    threadRootId: null,
    revision: '1',
    expiresAt: '2025-01-01T00:00:00.000Z',
    acceptedReplyId: null,
  }
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(expired.id, expired.kind, null, expired.revision, JSON.stringify(expired))
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const env = { BOTTEGA_RECORD_API_URL: 'https://record.test' }
  expect(reapBoardMessagesForInstall(env, Date.parse('2026-10-05T12:00:00.000Z'))).toBe(1)
  expect(db().query('SELECT id FROM hosted_board_message_cache').all()).toEqual([])
})

test('guarded board rows return locally and stop with a hosted-reader remedy after adoption', () => {
  const local = postNotice({ audience: 'operator', title: 'Local row', body: 'Local body.' })
  expect(messageRows().map((row) => row.record_id)).toContain(local.recordId)
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  const endpoint = process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
  try {
    expect(() => messageRows()).toThrow(
      'requireLocalBoardRead stopped a local board read; a hosted install reads the board through the hosted reader',
    )
    expect(() =>
      postNotice(
        { audience: 'operator', title: 'Hosted local write', body: 'Must stop.' },
        { BOTTEGA_RECORD_API_URL: 'https://record.test' },
      ),
    ).toThrow(/requireLocalBoardWrite stopped local board notice post/)
  } finally {
    if (endpoint === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = endpoint
  }
})

test('hosted delivery marking allows an empty local id list and refuses a local id', () => {
  const prior = process.env.BOTTEGA_RECORD_API_URL
  db().query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
  try {
    expect(() => markSessionMessagesDelivered('hosted-session', [])).not.toThrow()
    expect(() => markSessionMessagesDelivered('hosted-session', [newRecordId()])).toThrow(
      /requireLocalBoardWrite stopped local board notice delivery/,
    )
  } finally {
    db().query('DELETE FROM schema_meta WHERE key=?').run(BOARD_HOSTED_ADOPTED_KEY)
    if (prior === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = prior
  }
})
