import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { db } from '../database/db.ts'
import { pendingBoardAcknowledgements } from './board-push-service.ts'
import { acknowledgeNotice, postNotice } from './board-service.ts'

const interruptHook = resolve(import.meta.dir, '../../hooks/board-interrupt.py')
const guardHook = resolve(import.meta.dir, '../../hooks/board-ack-guard.py')
const hookRoots: string[] = []

afterEach(() => {
  for (const root of hookRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createHookFixture(commandOutput: string, sleep = false) {
  const root = mkdtempSync(join(tmpdir(), 'board-hooks-'))
  hookRoots.push(root)
  const databasePath = join(root, 'orch.db')
  const database = new Database(databasePath)
  database.exec(`
    CREATE TABLE board_message(id INTEGER,kind TEXT,ack_required INTEGER,withdrawn_at TEXT,expires_at TEXT,author_session TEXT);
    CREATE TABLE board_receipt(message_id INTEGER,reader_session TEXT,acknowledged_at TEXT);
    CREATE TABLE hosted_board_message_cache(id TEXT,kind TEXT,payload TEXT);
    CREATE TABLE hosted_board_receipt_cache(message_id TEXT,reader_session TEXT,acknowledged_at TEXT);
    CREATE TABLE schema_meta(key TEXT PRIMARY KEY,value TEXT);
  `)
  database
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run('board_hosted_refresh_at', new Date().toISOString())
  const command = join(root, 'orch')
  const invocationLog = join(root, 'invocations')
  writeFileSync(
    command,
    sleep
      ? `#!/bin/sh\nprintf x >> '${invocationLog}'\nsleep 2\n`
      : `#!/bin/sh\nprintf x >> '${invocationLog}'\nprintf '%s\\n' '${commandOutput}'\n`,
  )
  chmodSync(command, 0o700)
  return { root, database, databasePath, command, invocationLog }
}

function invocationCount(fixture: ReturnType<typeof createHookFixture>) {
  try {
    return readFileSync(fixture.invocationLog, 'utf8').length
  } catch {
    return 0
  }
}

function addCandidate(fixture: ReturnType<typeof createHookFixture>, id: number) {
  fixture.database
    .query("INSERT INTO board_message VALUES (?,'notice',1,NULL,?,NULL)")
    .run(id, new Date(Date.now() + 60_000).toISOString())
}

function runHook(
  path: string,
  payload: string,
  fixture: ReturnType<typeof createHookFixture>,
  extra = {},
) {
  return Bun.spawnSync(['python3', path], {
    stdin: Buffer.from(payload),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      ORCH_RUN_ID: '',
      ORCH_DB: fixture.databasePath,
      ORCH_BOARD_BIN: fixture.command,
      TMPDIR: fixture.root,
      BOARD_PUSH_REFRESH_SECONDS: '60',
      BOARD_PUSH_REMIND_SECONDS: '300',
      BOARD_ACK_STOP_BLOCKS: '3',
      BOARD_PUSH_SLOW_TIMEOUT_SECONDS: '0.1',
      ...extra,
    },
  })
}

const hookOutput = JSON.stringify({
  notices: [
    { id: '7', text: 'Posted by: operator\nTitle: T\nBody: B\nDeadline: D\norch board ack 7' },
  ],
})

test('pending acknowledgement resolution combines local and hosted cache and excludes acknowledged or unaddressed notices', async () => {
  const clock = Date.parse('2026-10-07T12:00:00.000Z')
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
     VALUES ('push-reader','claude-code','architect','test','push-project','/tmp',NULL,?,?)`,
    )
    .run(new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const local = postNotice(
    { audience: 'project:push-project', title: 'Local', body: 'Local body', ackRequired: true },
    {},
    clock,
  )
  const acknowledged = postNotice(
    { audience: 'project:push-project', title: 'Done', body: 'Done body', ackRequired: true },
    {},
    clock + 1,
  )
  acknowledgeNotice(acknowledged.id, { CLAUDE_CODE_SESSION_ID: 'push-reader' }, clock + 2)
  const setMeta = db().query(
    'INSERT INTO schema_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  )
  setMeta.run('board_hosted_cache_owner', 'user-1')
  setMeta.run('board_hosted_signed_in_user', 'user-1')
  const hosted = {
    id: '01990000-0000-7000-8000-000000000111',
    kind: 'notice',
    threadRootId: null,
    title: 'Hosted',
    body: 'Hosted body',
    audience: 'project:push-project',
    origin: { kind: 'operator', session: null, harness: null, project: null, runId: null },
    senderTags: [],
    createdAt: new Date(clock).toISOString(),
    expiresAt: new Date(clock + 60_000).toISOString(),
    withdrawnAt: null,
    state: 'open',
    acceptedReplyId: null,
    acceptedBy: null,
    acceptedAt: null,
    noteId: null,
    notePendingError: null,
    revision: '1',
    scopeProjectIds: [],
    recipientUserIds: [],
    claimId: null,
    authorUserId: 'user-1',
    authorSession: null,
    ackRequired: true,
    ackDeadline: new Date(clock + 30_000).toISOString(),
  }
  db()
    .query(
      'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
    )
    .run(hosted.id, hosted.kind, null, hosted.revision, JSON.stringify(hosted))

  const pending = await pendingBoardAcknowledgements({
    session: 'push-reader',
    deliver: false,
    budgetMs: 1,
    clock: clock + 3,
  })
  expect(pending.map((notice) => notice.id).sort()).toEqual([String(local.id), hosted.id].sort())
})

test('delivery stamps the notice and suppresses it until the reminder interval', async () => {
  const clock = Date.parse('2026-10-08T12:00:00.000Z')
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
     VALUES ('remind-reader','claude-code','architect','test','remind-project','/tmp',NULL,?,?)`,
    )
    .run(new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const posted = postNotice(
    { audience: 'project:remind-project', title: 'Reminder', body: 'Remember', ackRequired: true },
    {},
    clock,
  )
  const claim = (at: number) =>
    pendingBoardAcknowledgements({
      session: 'remind-reader',
      deliver: true,
      budgetMs: 1,
      remindSeconds: 300,
      clock: at,
    })
  expect((await claim(clock + 1)).map((notice) => notice.id)).toEqual([String(posted.id)])
  expect(await claim(clock + 299_999)).toEqual([])
  expect((await claim(clock + 300_001)).map((notice) => notice.id)).toEqual([String(posted.id)])
})

test('PostToolUse is silent for workers, malformed input, missing stores, and the cheap no-pending path', () => {
  const item = createHookFixture(hookOutput)
  for (const [payload, extra] of [
    ['{}', { ORCH_RUN_ID: '9' }],
    ['{', {}],
    ['{}', { ORCH_DB: join(item.root, 'missing.db') }],
    [JSON.stringify({ session_id: 'reader' }), {}],
  ] as const) {
    const result = runHook(interruptHook, payload, item, extra)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('')
  }
})

test('PostToolUse injects pending text and fails open on command timeout', () => {
  const item = createHookFixture(hookOutput)
  addCandidate(item, 1)
  const result = runHook(interruptHook, JSON.stringify({ session_id: 'reader' }), item)
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString()).hookSpecificOutput).toEqual({
    hookEventName: 'PostToolUse',
    additionalContext: JSON.parse(hookOutput).notices[0].text,
  })

  const slow = createHookFixture(hookOutput, true)
  addCandidate(slow, 1)
  const timed = runHook(interruptHook, JSON.stringify({ session_id: 'reader' }), slow)
  expect(timed.exitCode).toBe(0)
  expect(timed.stdout.toString()).toBe('')
})

test('PostToolUse checks an unaddressed candidate only once until a new id arrives', () => {
  const item = createHookFixture('{"notices":[]}')
  addCandidate(item, 1)
  const payload = JSON.stringify({ session_id: 'reader' })
  runHook(interruptHook, payload, item)
  runHook(interruptHook, payload, item)
  expect(invocationCount(item)).toBe(1)

  addCandidate(item, 2)
  runHook(interruptHook, payload, item)
  expect(invocationCount(item)).toBe(2)
})

test('PostToolUse rechecks candidates after the reminder interval', () => {
  const item = createHookFixture('{"notices":[]}')
  addCandidate(item, 1)
  const payload = JSON.stringify({ session_id: 'reader' })
  runHook(interruptHook, payload, item)
  const markerRoot = join(item.root, 'orch-board-interrupt')
  const marker = join(markerRoot, readdirSync(markerRoot)[0]!)
  const value = JSON.parse(readFileSync(marker, 'utf8'))
  writeFileSync(marker, JSON.stringify({ ...value, ran_at: 0 }))

  runHook(interruptHook, payload, item)
  expect(invocationCount(item)).toBe(2)
})

test('PostToolUse refreshes a stale hosted cache at most once per refresh interval', () => {
  const item = createHookFixture('{"notices":[]}')
  item.database
    .query("UPDATE schema_meta SET value='2000-01-01T00:00:00.000Z' WHERE key=?")
    .run('board_hosted_refresh_at')
  const payload = JSON.stringify({ session_id: 'reader' })
  runHook(interruptHook, payload, item)
  runHook(interruptHook, payload, item)
  expect(invocationCount(item)).toBe(1)
})

test('PostToolUse runs and returns correct output when its marker is unreadable', () => {
  const item = createHookFixture(hookOutput)
  addCandidate(item, 1)
  const marker = join(
    item.root,
    'orch-board-interrupt',
    createHash('sha256').update('reader').digest('hex'),
  )
  mkdirSync(marker, { recursive: true })

  const result = runHook(interruptHook, JSON.stringify({ session_id: 'reader' }), item)
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString()).hookSpecificOutput.additionalContext).toBe(
    JSON.parse(hookOutput).notices[0].text,
  )
  expect(invocationCount(item)).toBe(1)
})

test('Stop blocks three times and allows the fourth with a system message', () => {
  const item = createHookFixture(hookOutput)
  const values = Array.from({ length: 4 }, () =>
    JSON.parse(
      runHook(guardHook, JSON.stringify({ session_id: 'reader' }), item).stdout.toString(),
    ),
  )
  expect(values.slice(0, 3).every((value) => value.decision === 'block')).toBe(true)
  expect(values[3]).toEqual({ systemMessage: JSON.parse(hookOutput).notices[0].text })
})
