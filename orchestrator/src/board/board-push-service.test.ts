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
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { newRecordId } from '../../../shared/record/schema.ts'
import { installRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db } from '../database/db.ts'
import { takeClaim } from './board-claim-service.ts'
import { BOARD_PRESENCE_REFRESH_SECONDS, BOARD_PUSH_REFRESH_SECONDS } from './board-delivery.ts'
import { markBoardDeliveryDelivered, pendingBoardDelivery } from './board-push-service.ts'
import { BOARD_DELIVERY_MAX_MESSAGES } from './board-render.ts'
import { postNotice } from './board-service.ts'
import { askQuestion, replyToThread } from './board-thread-service.ts'

const interruptHook = resolve(import.meta.dir, '../../hooks/board-interrupt.py')
const interruptHookTest = resolve(import.meta.dir, '../../hooks/test_board_interrupt.py')
const guardHook = resolve(import.meta.dir, '../../hooks/board-ack-guard.py')
const postingCwd = resolve(import.meta.dir, '../../..')
const hookRoots: string[] = []

function ensurePostingProject() {
  db()
    .query(
      `INSERT OR IGNORE INTO project(record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'push-project',?,'{}')`,
    )
    .run(postingCwd)
}

afterEach(() => {
  for (const root of hookRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  installRecordApiClient(null)
})

function createHookFixture(
  commandOutput: string,
  behavior: 'success' | 'timeout' | 'failure' = 'success',
) {
  const root = mkdtempSync(join(tmpdir(), 'board-hooks-'))
  hookRoots.push(root)
  const databasePath = join(root, 'orch.db')
  const database = new Database(databasePath)
  database.exec(`
    CREATE TABLE board_message(record_id TEXT,number INTEGER,kind TEXT,ack_required INTEGER,withdrawn_at TEXT,expires_at TEXT,author_session TEXT);
    CREATE TABLE board_receipt(message_record_id TEXT,reader_session TEXT,delivered_at TEXT,acknowledged_at TEXT);
    CREATE TABLE hosted_board_message_cache(id TEXT,kind TEXT,payload TEXT);
    CREATE TABLE hosted_board_receipt_cache(message_id TEXT,reader_session TEXT,delivered_at TEXT,acknowledged_at TEXT);
    CREATE TABLE schema_meta(key TEXT PRIMARY KEY,value TEXT);
  `)
  database
    .query('INSERT INTO schema_meta(key,value) VALUES (?,?)')
    .run('board_hosted_refresh_at', new Date().toISOString())
  const command = join(root, 'orch')
  const invocationLog = join(root, 'invocations')
  writeFileSync(
    command,
    behavior === 'timeout'
      ? `#!/bin/sh\nprintf x >> '${invocationLog}'\nsleep 2\n`
      : behavior === 'failure'
        ? `#!/bin/sh\nprintf x >> '${invocationLog}'\nexit 1\n`
        : `#!/bin/sh\nif [ "$2" = "presence" ]; then printf p >> '${root}/presence-calls'; printf '%s\\n' "$*" >> '${root}/presence-args'; exit 0; fi\nif [ "$2" = "pending" ]; then printf x >> '${invocationLog}'; printf '%s\\n' '${commandOutput}'; fi\n`,
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

function setCommandOutput(fixture: ReturnType<typeof createHookFixture>, output: string) {
  writeFileSync(
    fixture.command,
    `#!/bin/sh\nif [ "$2" = "presence" ]; then printf p >> '${fixture.root}/presence-calls'; printf '%s\\n' "$*" >> '${fixture.root}/presence-args'; exit 0; fi\nif [ "$2" = "pending" ]; then printf x >> '${fixture.invocationLog}'; printf '%s\\n' '${output}'; fi\n`,
  )
  chmodSync(fixture.command, 0o700)
}

function presenceCallCount(fixture: ReturnType<typeof createHookFixture>) {
  try {
    return readFileSync(join(fixture.root, 'presence-calls'), 'utf8').length
  } catch {
    return 0
  }
}

function presenceArgs(fixture: ReturnType<typeof createHookFixture>) {
  try {
    return readFileSync(join(fixture.root, 'presence-args'), 'utf8')
  } catch {
    return ''
  }
}

function writeTranscript(fixture: ReturnType<typeof createHookFixture>) {
  const path = join(fixture.root, 'transcript.jsonl')
  writeFileSync(path, `${JSON.stringify({ timestamp: '2026-10-13T12:00:00.000Z' })}\n`)
  return path
}

function addCandidate(fixture: ReturnType<typeof createHookFixture>, id: number) {
  fixture.database
    .query("INSERT INTO board_message VALUES (?,?, 'notice',1,NULL,?,NULL)")
    .run(newRecordId(), id, new Date(Date.now() + 60_000).toISOString())
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
      BOARD_PUSH_REFRESH_SECONDS: String(BOARD_PUSH_REFRESH_SECONDS),
      BOARD_PUSH_REMIND_SECONDS: '300',
      BOARD_PUSH_RETRY_SECONDS: '15',
      BOARD_PRESENCE_REFRESH_SECONDS: String(BOARD_PRESENCE_REFRESH_SECONDS),
      BOARD_ACK_STOP_BLOCKS: '3',
      BOARD_PUSH_SLOW_TIMEOUT_SECONDS: '5',
      ORCH_BOARD_HOOK_STATE: join(fixture.root, 'board-hook-state'),
      ...extra,
    },
  })
}

type RepeatedHookResult = {
  outputs: string[]
  delivered: Array<[string, string[], string]>
  emittedLimit: number | null
  atomicWritten: boolean
  atomicValue: unknown
  atomicTemporaryFiles: string[]
}

function runHookRepeatedResult(
  path: string,
  payload: string,
  fixture: ReturnType<typeof createHookFixture>,
  times: number,
  pendingValues: Array<
    Array<{ id: string; text: string; requiresAcknowledgement: boolean }>
  > | null = null,
  markFailure: boolean | 'once' = false,
) {
  const runner = [
    'import contextlib, importlib.util, io, json, os, sys',
    'sys.path.insert(0, os.path.dirname(sys.argv[1]))',
    'spec = importlib.util.spec_from_file_location("board_hook_test", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'pending_values = json.loads(sys.argv[4])',
    'if pending_values is not None:',
    '    pending_iterator = iter(pending_values)',
    '    module.pending = lambda session, recently_injected=None, exclude_acknowledgements=False: (lambda value: ([item for item in value if not (exclude_acknowledgements and item["requiresAcknowledgement"])], None, [item for item in value if item["requiresAcknowledgement"]]))(next(pending_iterator))',
    'delivered = []',
    'def mark_delivered(session, ids, delivery_point, emission_id, blocked_stop=False):',
    '    delivered.append([session, ids, emission_id])',
    '    failure_mode = json.loads(sys.argv[5])',
    '    if failure_mode is True or (failure_mode == "once" and len(delivered) == 1): raise RuntimeError("delivery stamp failed")',
    'module.mark_delivered = mark_delivered',
    'atomic_path = os.path.join(os.environ["ORCH_BOARD_HOOK_STATE"], "atomic-test")',
    'module.write_marker(atomic_path, {"previous": True})',
    'atomic_written = module.write_marker(atomic_path, {"partial": "value", "broken": object()})',
    'atomic_value = module.read_marker(atomic_path)',
    'atomic_temporary_files = [name for name in os.listdir(os.path.dirname(atomic_path)) if name.startswith(".marker-")]',
    'outputs = []',
    'for _ in range(int(sys.argv[3])):',
    '    output = io.StringIO()',
    '    sys.stdin = io.StringIO(sys.argv[2])',
    '    with contextlib.redirect_stdout(output): module.main()',
    '    outputs.append(output.getvalue())',
    'print(json.dumps({"outputs": outputs, "delivered": delivered, "emittedLimit": getattr(module, "STOP_EMITTED_ID_LIMIT", None), "atomicWritten": atomic_written, "atomicValue": atomic_value, "atomicTemporaryFiles": atomic_temporary_files}))',
  ].join('\n')
  const result = Bun.spawnSync(
    [
      'python3',
      '-c',
      runner,
      path,
      payload,
      String(times),
      JSON.stringify(pendingValues),
      JSON.stringify(markFailure),
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        ORCH_RUN_ID: '',
        ORCH_DB: fixture.databasePath,
        ORCH_BOARD_BIN: fixture.command,
        BOARD_PUSH_REFRESH_SECONDS: String(BOARD_PUSH_REFRESH_SECONDS),
        BOARD_PUSH_REMIND_SECONDS: '300',
        BOARD_PUSH_RETRY_SECONDS: '15',
        BOARD_PRESENCE_REFRESH_SECONDS: String(BOARD_PRESENCE_REFRESH_SECONDS),
        BOARD_ACK_STOP_BLOCKS: '3',
        BOARD_PUSH_SLOW_TIMEOUT_SECONDS: '5',
        ORCH_BOARD_HOOK_STATE: join(fixture.root, 'board-hook-state'),
      },
    },
  )
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString()) as RepeatedHookResult
}

function runHookRepeated(
  path: string,
  payload: string,
  fixture: ReturnType<typeof createHookFixture>,
  times: number,
  pendingValues: Array<
    Array<{ id: string; text: string; requiresAcknowledgement: boolean }>
  > | null = null,
) {
  return runHookRepeatedResult(path, payload, fixture, times, pendingValues).outputs
}

const hookOutput = JSON.stringify({
  delivery: [
    {
      id: '7',
      text: 'Posted by: operator\nTitle: T\nBody: B\nDeadline: D\norch board ack 7',
      requiresAcknowledgement: true,
    },
  ],
  overflow: null,
  pendingAcknowledgements: [
    {
      id: '7',
      text: 'Posted by: operator\nTitle: T\nBody: B\nDeadline: D\norch board ack 7',
      requiresAcknowledgement: true,
    },
  ],
})

test('an architect may address architects without receiving its own post', async () => {
  ensurePostingProject()
  const clock = Date.parse('2026-10-07T13:00:00.000Z')
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES ('posting-reader','claude-code','architect','test','push-project',(SELECT record_id FROM project WHERE name='push-project'),'/tmp',NULL,?,?)`,
    )
    .run(new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  expect(() =>
    postNotice(
      { audience: 'architects', title: 'Own', body: 'Own body' },
      { CLAUDE_CODE_SESSION_ID: 'posting-reader' },
      clock,
      postingCwd,
    ),
  ).not.toThrow()
  const delivery = await pendingBoardDelivery({
    session: 'posting-reader',
    budgetMs: 1,
    clock: clock + 1,
  })
  expect(delivery.delivery).toEqual([])
})

test('a claim-conflict delivery is not a pending acknowledgement', async () => {
  ensurePostingProject()
  const clock = Date.parse('2026-10-07T13:30:00.000Z')
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES ('claim-holder','claude-code','architect','test','push-project',(SELECT record_id FROM project WHERE name='push-project'),'/tmp',NULL,?,?)`,
    )
    .run(new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  takeClaim(
    { subject: 'resource:push-test', project: 'push-project' },
    { CLAUDE_CODE_SESSION_ID: 'claim-holder' },
    clock,
    postingCwd,
  )
  expect(() =>
    takeClaim(
      { subject: 'resource:push-test', project: 'push-project' },
      { CLAUDE_CODE_SESSION_ID: 'claim-contender' },
      clock + 1,
      postingCwd,
    ),
  ).toThrow(/session claim-holder/)

  const pending = await pendingBoardDelivery({
    session: 'claim-holder',
    budgetMs: 0,
    clock: clock + 2,
  })
  expect(pending.delivery).toHaveLength(1)
  expect(pending.delivery[0]!.requiresAcknowledgement).toBeFalse()
  expect(pending.pendingAcknowledgements).toEqual([])
})

test('mid-session local delivery includes an ordinary notice, question, and participant reply once', async () => {
  ensurePostingProject()
  const clock = Date.parse('2026-10-07T14:00:00.000Z')
  for (const session of ['delivery-reader', 'thread-author'])
    db()
      .query(
        `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
         VALUES (?,'claude-code','architect','test','push-project',(SELECT record_id FROM project WHERE name='push-project'),'/tmp',NULL,?,?)`,
      )
      .run(session, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const ordinary = postNotice(
    {
      audience: 'session:delivery-reader',
      title: 'Ordinary',
      body: 'notice body',
    },
    {},
    clock,
  )
  const purposeMessages = [
    { title: 'Requested action', body: 'request body', purpose: 'request' as const },
    { title: 'Standing rule', body: 'standing body', purpose: 'standing' as const },
  ].map((input) => postNotice({ audience: 'session:delivery-reader', ...input }, {}, clock + 1))
  const request = purposeMessages[0]!
  const standing = purposeMessages[1]!
  const question = askQuestion(
    {
      audience: 'session:delivery-reader',
      title: 'Question',
      body: 'question body',
    },
    { CLAUDE_CODE_SESSION_ID: 'thread-author' },
    clock + 1,
    postingCwd,
  )
  const first = await pendingBoardDelivery({
    session: 'delivery-reader',
    budgetMs: 1,
    clock: clock + 2,
  })
  expect(first.delivery.map((message) => message.id)).toEqual([
    String(ordinary.number),
    String(request.number),
    String(standing.number),
    String(question.number),
  ])
  const text = (id: string) => first.delivery.find((message) => message.id === id)!.text
  expect(text(String(ordinary.number))).not.toContain('notice body')
  expect(text(String(request.number))).toContain('request body')
  expect(text(String(standing.number))).toContain('standing body')
  await markBoardDeliveryDelivered({
    session: 'delivery-reader',
    ids: [ordinary.recordId, ...first.delivery.slice(1).map((message) => message.id)],
    clock: clock + 2,
  })
  replyToThread(
    question.recordId,
    'reader participated',
    { CLAUDE_CODE_SESSION_ID: 'delivery-reader' },
    clock + 3,
    postingCwd,
  )
  const reply = replyToThread(
    question.recordId,
    'author followed up',
    { CLAUDE_CODE_SESSION_ID: 'thread-author' },
    clock + 4,
    postingCwd,
  )
  const second = await pendingBoardDelivery({
    session: 'delivery-reader',
    budgetMs: 1,
    clock: clock + 5,
  })
  expect(second.delivery.map((message) => message.id)).toEqual([String(reply.number)])
  await markBoardDeliveryDelivered({
    session: 'delivery-reader',
    ids: second.delivery.map((message) => message.id),
    clock: clock + 5,
  })
  expect(
    (
      await pendingBoardDelivery({
        session: 'delivery-reader',
        budgetMs: 1,
        clock: clock + 6,
      })
    ).delivery,
  ).toEqual([])
})

test('mid-session hosted delivery includes an ordinary notice, question, and participant reply once', async () => {
  const clock = Date.parse('2026-10-07T15:00:00.000Z')
  const reader = 'hosted-delivery-reader'
  const signedInUser = newRecordId()
  const otherUser = newRecordId()
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test','push-project',(SELECT record_id FROM project WHERE name='push-project'),'/tmp',NULL,?,?)`,
    )
    .run(reader, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const setMeta = db().query(
    'INSERT INTO schema_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  )
  setMeta.run('board_hosted_cache_owner', signedInUser)
  setMeta.run('board_hosted_signed_in_user', signedInUser)
  const rootId = newRecordId()
  const base = {
    threadRootId: null,
    title: 'Hosted',
    body: 'hosted body',
    audience: `session:${reader}`,
    origin: {
      kind: 'architect',
      session: 'other',
      harness: 'claude-code',
      project: null,
      runId: null,
    },
    senderTags: [],
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
    authorUserId: otherUser,
    authorSession: 'other',
    ackRequired: false,
    ackDeadline: null,
  }
  const messages = [
    {
      ...base,
      id: newRecordId(),
      kind: 'notice',
      createdAt: new Date(clock).toISOString(),
    },
    {
      ...base,
      id: newRecordId(),
      kind: 'question',
      createdAt: new Date(clock + 1).toISOString(),
    },
    {
      ...base,
      id: rootId,
      kind: 'question',
      createdAt: new Date(clock + 2).toISOString(),
      authorUserId: signedInUser,
      authorSession: reader,
      origin: { ...base.origin, session: reader },
    },
    {
      ...base,
      id: newRecordId(),
      kind: 'reply',
      threadRootId: rootId,
      audience: null,
      title: null,
      createdAt: new Date(clock + 3).toISOString(),
    },
  ]
  const insert = db().query(
    'INSERT INTO hosted_board_message_cache(id,kind,thread_root_id,revision,payload) VALUES (?,?,?,?,?)',
  )
  for (const message of messages)
    insert.run(
      message.id,
      message.kind,
      message.threadRootId,
      message.revision,
      JSON.stringify(message),
    )
  const first = await pendingBoardDelivery({
    session: reader,
    budgetMs: 1,
    clock: clock + 4,
  })
  expect(first.delivery.map((message) => message.id)).toEqual([
    messages[0]!.id,
    messages[1]!.id,
    messages[3]!.id,
  ])
  await markBoardDeliveryDelivered({
    session: reader,
    ids: first.delivery.map((message) => message.id),
    clock: clock + 4,
  })
  const second = await pendingBoardDelivery({
    session: reader,
    budgetMs: 1,
    clock: clock + 5,
  })
  expect(second.delivery).toEqual([])
})

test('the hook SQL remains a deliberately broad prefilter of the TypeScript owner', () => {
  const hook = readFileSync(interruptHook, 'utf8')
  const owner = readFileSync(resolve(import.meta.dir, 'board-push-service.ts'), 'utf8')
  expect(hook).toContain('Broad prefilter for board-push-service.ts, the eligibility owner.')
  for (const [hookClause, ownerClause] of [
    ["m.kind='notice'", "row.kind === 'notice'"],
    ['m.ack_required=1', 'row.ack_required === 1'],
    ['m.author_session<>?', 'row.author_session !== session'],
    ['r.acknowledged_at IS NOT NULL', 'receipt.acknowledged_at === null'],
    ["m.kind='notice'", "message.kind === 'notice'"],
    ["json_extract(m.payload,'$.ackRequired')=1", 'message.ackRequired'],
    ["json_extract(m.payload,'$.authorSession')<>?", 'message.authorSession !== session'],
  ] as const) {
    expect(hook).toContain(hookClause)
    expect(owner).toContain(ownerClause)
  }
})

test('delivery returns every pending notice and preserves its first delivered time', async () => {
  const clock = Date.parse('2026-10-08T12:00:00.000Z')
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
     VALUES ('remind-reader','claude-code','architect','test','remind-project',(SELECT record_id FROM project WHERE name='remind-project'),'/tmp',NULL,?,?)`,
    )
    .run(new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const posted = postNotice(
    {
      audience: 'project:remind-project',
      title: 'Reminder',
      body: 'Remember',
      ackRequired: true,
      purpose: 'request',
    },
    {},
    clock,
  )
  const claim = (at: number) =>
    pendingBoardDelivery({
      session: 'remind-reader',
      budgetMs: 1,
      includeAcknowledgementReminders: true,
      clock: at,
    })
  expect((await claim(clock + 1)).delivery.map((notice) => notice.id)).toEqual([
    String(posted.number),
  ])
  await markBoardDeliveryDelivered({
    session: 'remind-reader',
    ids: [String(posted.number)],
    clock: clock + 1,
  })
  expect(
    (
      await pendingBoardDelivery({
        session: 'remind-reader',
        budgetMs: 1,
        clock: clock + 2,
      })
    ).delivery,
  ).toEqual([])
  const first = db()
    .query('SELECT delivered_at FROM board_receipt WHERE message_record_id=? AND reader_session=?')
    .get(posted.recordId, 'remind-reader') as { delivered_at: string }
  expect((await claim(clock + 299_999)).pendingAcknowledgements.map((notice) => notice.id)).toEqual(
    [String(posted.number)],
  )
  expect((await claim(clock + 299_999)).delivery.map((notice) => notice.id)).toEqual([
    String(posted.number),
  ])
  expect((await claim(clock + 300_001)).pendingAcknowledgements.map((notice) => notice.id)).toEqual(
    [String(posted.number)],
  )
  expect(
    db()
      .query(
        'SELECT delivered_at FROM board_receipt WHERE message_record_id=? AND reader_session=?',
      )
      .get(posted.recordId, 'remind-reader'),
  ).toEqual(first)
})

test('recent reminders are removed before bounding without changing pending acknowledgements', async () => {
  const clock = Date.parse('2026-10-08T12:30:00.000Z')
  const session = 'bounded-reminder-reader'
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test','push-project',(SELECT record_id FROM project WHERE name='push-project'),'/tmp',NULL,?,?)`,
    )
    .run(session, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const reminders = Array.from({ length: BOARD_DELIVERY_MAX_MESSAGES }, (_, index) =>
    postNotice(
      {
        audience: `session:${session}`,
        title: `Reminder ${index}`,
        body: 'Remember',
        ackRequired: true,
        purpose: 'request',
      },
      {},
      clock + index,
    ),
  )
  await markBoardDeliveryDelivered({
    session,
    ids: reminders.map((notice) => String(notice.number)),
    clock: clock + 10,
  })
  const ordinary = postNotice(
    { audience: `session:${session}`, title: 'Fresh', body: 'Fresh body' },
    {},
    clock + 11,
  )

  const result = await pendingBoardDelivery({
    session,
    budgetMs: 0,
    includeAcknowledgementReminders: true,
    recentlyInjectedIds: reminders.map((notice) => String(notice.number)),
    clock: clock + 12,
  })

  expect(result.delivery.map((notice) => notice.id)).toEqual([String(ordinary.number)])
  expect(result.pendingAcknowledgements.map((notice) => notice.id)).toEqual(
    reminders.map((notice) => String(notice.number)),
  )
})

test('ordinary-only delivery excludes required notices before bounding', async () => {
  const clock = Date.parse('2026-10-08T12:40:00.000Z')
  const session = 'ordinary-only-reader'
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test','push-project',(SELECT record_id FROM project WHERE name='push-project'),'/tmp',NULL,?,?)`,
    )
    .run(session, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const required = Array.from({ length: BOARD_DELIVERY_MAX_MESSAGES }, (_, index) =>
    postNotice(
      {
        audience: `session:${session}`,
        title: `Required ${index}`,
        body: 'Acknowledge me',
        ackRequired: true,
        purpose: 'request',
      },
      {},
      clock + index,
    ),
  )
  const ordinary = postNotice(
    { audience: `session:${session}`, title: 'Ordinary', body: 'Show me' },
    {},
    clock + required.length,
  )

  const result = await pendingBoardDelivery({
    session,
    budgetMs: 0,
    includeAcknowledgementReminders: true,
    excludeAcknowledgementRequired: true,
    clock: clock + required.length + 1,
  })

  expect(result.delivery.map((notice) => notice.id)).toEqual([String(ordinary.number)])
  expect(result.pendingAcknowledgements.map((notice) => notice.id)).toEqual(
    required.map((notice) => String(notice.number)),
  )
})

test('recently-injected ids do not suppress messages never delivered to the session', async () => {
  const clock = Date.parse('2026-10-08T12:45:00.000Z')
  const session = 'unread-reminder-reader'
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test','push-project',(SELECT record_id FROM project WHERE name='push-project'),'/tmp',NULL,?,?)`,
    )
    .run(session, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const unread = postNotice(
    {
      audience: `session:${session}`,
      title: 'Unread acknowledgement',
      body: 'Must still arrive',
      ackRequired: true,
      purpose: 'request',
    },
    {},
    clock,
  )

  const result = await pendingBoardDelivery({
    session,
    budgetMs: 0,
    includeAcknowledgementReminders: true,
    recentlyInjectedIds: [String(unread.number)],
    clock: clock + 1,
  })

  expect(result.delivery.map((notice) => notice.id)).toEqual([String(unread.number)])
})

test('board interrupt presence helpers match the canonical hook behavior', () => {
  const result = Bun.spawnSync(['python3', interruptHookTest], { stdout: 'pipe', stderr: 'pipe' })
  expect({
    exitCode: result.exitCode,
    output: result.exitCode === 0 ? 'ok' : `${result.stdout.toString()}${result.stderr.toString()}`,
  }).toEqual({ exitCode: 0, output: 'ok' })
})

test('PostToolUse does not repair presence without a session start', () => {
  const item = createHookFixture(hookOutput)
  item.database.exec('CREATE TABLE presence(session_id TEXT PRIMARY KEY)')
  addCandidate(item, 1)
  const result = runHook(interruptHook, JSON.stringify({ session_id: 'reader' }), item)
  expect(result.exitCode).toBe(0)
  expect(presenceCallCount(item)).toBe(0)
  const markerRoot = join(item.root, 'board-hook-state', 'presence')
  const marker = join(markerRoot, readdirSync(markerRoot)[0]!)
  expect(JSON.parse(readFileSync(marker, 'utf8')).skip).toBe('no transcript_path')
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

test('PostToolUse injects pending text', () => {
  const item = createHookFixture(hookOutput)
  item.database.exec('CREATE TABLE presence(session_id TEXT PRIMARY KEY)')
  addCandidate(item, 1)
  const result = runHook(
    interruptHook,
    JSON.stringify({ session_id: 'reader', transcript_path: writeTranscript(item) }),
    item,
  )
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString()).hookSpecificOutput).toEqual({
    hookEventName: 'PostToolUse',
    additionalContext: JSON.parse(hookOutput).delivery[0].text,
  })
  expect(presenceCallCount(item)).toBe(1)
  expect(presenceArgs(item)).toContain('--began-at')
})

test('PostToolUse fails open on command timeout', () => {
  const slow = createHookFixture(hookOutput, 'timeout')
  addCandidate(slow, 1)
  const timed = runHook(interruptHook, JSON.stringify({ session_id: 'reader' }), slow, {
    BOARD_PUSH_SLOW_TIMEOUT_SECONDS: '0.1',
  })
  expect(timed.exitCode).toBe(0)
  expect(timed.stdout.toString()).toBe('')
})

test('PostToolUse fails open on malformed command output', () => {
  const malformed = createHookFixture('{')
  addCandidate(malformed, 1)
  const broken = runHook(interruptHook, JSON.stringify({ session_id: 'reader' }), malformed)
  expect(broken.exitCode).toBe(0)
  expect(broken.stdout.toString()).toBe('')
})

test('PostToolUse checks an unaddressed candidate only once until a new id arrives', () => {
  const item = createHookFixture('{"delivery":[],"overflow":null,"pendingAcknowledgements":[]}')
  item.database.exec('CREATE TABLE presence(session_id TEXT PRIMARY KEY)')
  addCandidate(item, 1)
  const payload = JSON.stringify({
    session_id: 'reader',
    transcript_path: writeTranscript(item),
  })
  runHookRepeated(interruptHook, payload, item, 2)
  expect(invocationCount(item)).toBe(1)
  expect(presenceCallCount(item)).toBe(1)

  addCandidate(item, 2)
  runHook(interruptHook, payload, item)
  expect(invocationCount(item)).toBe(2)
  expect(presenceCallCount(item)).toBe(1)
})

test('PostToolUse injects once and again only after the reminder interval', () => {
  const item = createHookFixture(hookOutput)
  addCandidate(item, 1)
  const payload = JSON.stringify({ session_id: 'reader' })
  const initial = runHookRepeated(interruptHook, payload, item, 2)
  expect(initial[0]).not.toBe('')
  expect(initial[1]).toBe('')
  const markerRoot = join(item.root, 'board-hook-state', 'interrupt')
  const marker = join(markerRoot, readdirSync(markerRoot)[0]!)
  const value = JSON.parse(readFileSync(marker, 'utf8'))
  writeFileSync(marker, JSON.stringify({ ...value, ran_at: 0, injected_at: { '7': 0 } }))

  expect(runHook(interruptHook, payload, item).stdout.toString()).not.toBe('')
  expect(invocationCount(item)).toBe(2)
})

test('PostToolUse passes recent reminders before selection and stamps only fresh delivery', () => {
  const freshOutput = JSON.stringify({
    delivery: [{ id: '8', text: 'fresh notice', requiresAcknowledgement: false }],
    overflow: null,
    pendingAcknowledgements: [{ id: '7', text: 'recent reminder', requiresAcknowledgement: true }],
  })
  const item = createHookFixture(freshOutput)
  addCandidate(item, 7)
  addCandidate(item, 8)
  item.database
    .query(
      "INSERT INTO board_receipt SELECT record_id,'reader',?,NULL FROM board_message WHERE number=7",
    )
    .run(new Date().toISOString())
  item.database.query('UPDATE board_message SET ack_required=0 WHERE number=8').run()
  writeFileSync(
    item.command,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${item.invocationLog}'\nif [ "$2" = "pending" ]; then printf '%s\\n' '${freshOutput}'; fi\n`,
  )
  chmodSync(item.command, 0o700)
  const markerRoot = join(item.root, 'board-hook-state', 'interrupt')
  mkdirSync(markerRoot, { recursive: true })
  const marker = join(markerRoot, createHash('sha256').update('reader').digest('hex'))
  writeFileSync(
    marker,
    JSON.stringify({
      candidate_ids: ['7'],
      ran_at: 0,
      failure_at: 0,
      injected_at: { '7': Date.now() / 1000 },
    }),
  )

  const result = runHook(interruptHook, JSON.stringify({ session_id: 'reader' }), item)
  expect(JSON.parse(result.stdout.toString()).hookSpecificOutput.additionalContext).toBe(
    'fresh notice',
  )
  const invocations = readFileSync(item.invocationLog, 'utf8').trim().split('\n')
  expect(invocations[0]).toContain('--recently-injected 7')
  expect(invocations[1]).toMatch(
    /^board delivered 8 --session reader --point after-tool-call --emission [0-9a-f-]+$/,
  )
})

test('PostToolUse throttles a failed path until the retry interval', () => {
  const item = createHookFixture(hookOutput, 'failure')
  addCandidate(item, 1)
  const payload = JSON.stringify({ session_id: 'reader' })
  runHookRepeated(interruptHook, payload, item, 2)
  expect(invocationCount(item)).toBe(1)

  const markerRoot = join(item.root, 'board-hook-state', 'interrupt')
  const marker = join(markerRoot, readdirSync(markerRoot)[0]!)
  const value = JSON.parse(readFileSync(marker, 'utf8'))
  writeFileSync(marker, JSON.stringify({ ...value, failure_at: 0 }))
  setCommandOutput(item, hookOutput)
  expect(runHook(interruptHook, payload, item).stdout.toString()).not.toBe('')
  expect(invocationCount(item)).toBe(2)
})

test('PostToolUse refreshes a stale hosted cache at most once per refresh interval', () => {
  const item = createHookFixture('{"delivery":[],"overflow":null,"pendingAcknowledgements":[]}')
  item.database
    .query("UPDATE schema_meta SET value='2000-01-01T00:00:00.000Z' WHERE key=?")
    .run('board_hosted_refresh_at')
  const payload = JSON.stringify({ session_id: 'reader' })
  runHookRepeated(interruptHook, payload, item, 2)
  expect(invocationCount(item)).toBe(1)
})

test('PostToolUse runs correctly without following an unreadable marker symlink', () => {
  const item = createHookFixture(hookOutput)
  addCandidate(item, 1)
  const root = join(item.root, 'board-hook-state', 'interrupt')
  mkdirSync(root, { recursive: true })
  const target = join(item.root, 'target')
  writeFileSync(target, 'sentinel')
  const marker = join(root, createHash('sha256').update('reader').digest('hex'))
  symlinkSync(target, marker)

  const result = runHook(interruptHook, JSON.stringify({ session_id: 'reader' }), item)
  expect(invocationCount(item)).toBe(1)
  expect(result.stdout.toString()).not.toBe('')
  expect(readFileSync(target, 'utf8')).toBe('sentinel')
})

test('Stop keeps its acknowledgement budget and never blocks or stamps for ordinary delivery', () => {
  const item = createHookFixture(hookOutput)
  const required = JSON.parse(hookOutput).delivery
  const pendingValues = [
    [{ id: '8', text: 'ordinary within budget', requiresAcknowledgement: false }, ...required],
    required,
    required,
    required,
    [{ id: '9', text: 'ordinary after budget', requiresAcknowledgement: false }, ...required],
    required,
    [],
  ]
  const result = runHookRepeatedResult(
    guardHook,
    JSON.stringify({ session_id: 'reader' }),
    item,
    pendingValues.length,
    pendingValues,
  )
  const values = result.outputs.map((value) => (value ? JSON.parse(value) : null))
  expect(values.slice(0, 3).every((value) => value.decision === 'block')).toBe(true)
  expect(values[0].reason).toStartWith('This architect session has 1 unacknowledged board notice.')
  expect(values[0].reason).not.toContain('ordinary within budget')
  expect(values[3].systemMessage).toStartWith(
    'This architect session is stopping with 1 unacknowledged board notice.',
  )
  expect(values[4].decision).toBeUndefined()
  expect(values[4].systemMessage).not.toContain('ordinary after budget')
  expect(values[5].decision).toBeUndefined()
  expect(values[5].systemMessage).toContain('unacknowledged board notice')
  expect(result.outputs[6]).toBe('')
  expect(result.delivered).toEqual([])
})

test('Stop with only ordinary messages does not block, stamps nothing, and preserves markers atomically', () => {
  const item = createHookFixture(hookOutput)
  const first = { id: '1', text: 'first', requiresAcknowledgement: false }
  const second = { id: '2', text: 'second', requiresAcknowledgement: false }
  const pendingValues = [[first], [first, second]]
  const hook = runHookRepeatedResult(
    guardHook,
    JSON.stringify({ session_id: 'reader' }),
    item,
    pendingValues.length,
    pendingValues,
    false,
  )
  expect(hook.outputs).toEqual(['', ''])
  expect(hook.delivered).toEqual([])
  const markerRoot = join(item.root, 'board-hook-state', 'stop')
  const marker = join(markerRoot, readdirSync(markerRoot)[0]!)
  const value = JSON.parse(readFileSync(marker, 'utf8'))

  expect(value).toEqual({ blocks: 0 })
  expect(hook.atomicWritten).toBeFalse()
  expect(hook.atomicValue).toEqual({ previous: true })
  expect(hook.atomicTemporaryFiles).toEqual([])
})

test('Stop budget is per session, is not rearmed by new notices, and resets when clear', () => {
  const item = createHookFixture(hookOutput)
  const payload = JSON.stringify({ session_id: 'reader' })
  const one = JSON.parse(hookOutput).delivery
  const more = [
    ...one,
    { id: '8', text: 'second notice', requiresAcknowledgement: true },
    { id: '9', text: 'third notice', requiresAcknowledgement: true },
  ]
  const values = runHookRepeated(guardHook, payload, item, 6, [one, one, more, more, [], one])
  expect(values.slice(0, 3).every((value) => JSON.parse(value).decision === 'block')).toBe(true)
  expect(JSON.parse(values[3]!).decision).toBeUndefined()
  expect(values[4]).toBe('')
  expect(JSON.parse(values[5]!).decision).toBe('block')
})

test('Stop never holds a turn on a counter it cannot record, and does not follow its symlink', () => {
  const item = createHookFixture(hookOutput)
  const root = join(item.root, 'board-hook-state', 'stop')
  mkdirSync(root, { recursive: true })
  const target = join(item.root, 'stop-target')
  writeFileSync(target, 'sentinel')
  symlinkSync(target, join(root, createHash('sha256').update('reader').digest('hex')))

  const notices = JSON.parse(hookOutput).delivery
  const results = runHookRepeated(guardHook, JSON.stringify({ session_id: 'reader' }), item, 2, [
    notices,
    notices,
  ])
  expect(results).toEqual(['', ''])
  expect(readFileSync(target, 'utf8')).toBe('sentinel')
})
