import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const interrupt = resolve(import.meta.dir, '../../hooks/board-interrupt.py')
const guard = resolve(import.meta.dir, '../../hooks/board-ack-guard.py')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createFixture(commandOutput: string, sleep = false) {
  const root = mkdtempSync(join(tmpdir(), 'board-hooks-'))
  roots.push(root)
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
  writeFileSync(
    command,
    sleep ? '#!/bin/sh\nsleep 2\n' : `#!/bin/sh\nprintf '%s\\n' '${commandOutput}'\n`,
  )
  chmodSync(command, 0o700)
  return { root, database, databasePath, command }
}

function run(path: string, payload: string, fixture: ReturnType<typeof createFixture>, extra = {}) {
  return Bun.spawnSync(['python3', path], {
    stdin: Buffer.from(payload),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
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

const output = JSON.stringify({
  notices: [
    { id: '7', text: 'Posted by: operator\nTitle: T\nBody: B\nDeadline: D\norch board ack 7' },
  ],
})

test('PostToolUse is silent for workers, malformed input, missing stores, and the cheap no-pending path', () => {
  const item = createFixture(output)
  for (const [payload, extra] of [
    ['{}', { ORCH_RUN_ID: '9' }],
    ['{', {}],
    ['{}', { ORCH_DB: join(item.root, 'missing.db') }],
    [JSON.stringify({ session_id: 'reader' }), {}],
  ] as const) {
    const result = run(interrupt, payload, item, extra)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe('')
  }
})

test('PostToolUse injects pending text and fails open on command timeout', () => {
  const item = createFixture(output)
  item.database
    .query("INSERT INTO board_message VALUES (1,'notice',1,NULL,?,NULL)")
    .run(new Date(Date.now() + 60_000).toISOString())
  const result = run(interrupt, JSON.stringify({ session_id: 'reader' }), item)
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString()).hookSpecificOutput).toEqual({
    hookEventName: 'PostToolUse',
    additionalContext: JSON.parse(output).notices[0].text,
  })

  const slow = createFixture(output, true)
  slow.database
    .query("INSERT INTO board_message VALUES (1,'notice',1,NULL,?,NULL)")
    .run(new Date(Date.now() + 60_000).toISOString())
  const timed = run(interrupt, JSON.stringify({ session_id: 'reader' }), slow)
  expect(timed.exitCode).toBe(0)
  expect(timed.stdout.toString()).toBe('')
})

test('Stop blocks three times and allows the fourth with a system message', () => {
  const item = createFixture(output)
  const values = Array.from({ length: 4 }, () =>
    JSON.parse(run(guard, JSON.stringify({ session_id: 'reader' }), item).stdout.toString()),
  )
  expect(values.slice(0, 3).every((value) => value.decision === 'block')).toBe(true)
  expect(values[3]).toEqual({ systemMessage: JSON.parse(output).notices[0].text })
})
