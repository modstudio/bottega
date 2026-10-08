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
import { db } from '../database/db.ts'
import { takeClaim } from './board-claim-service.ts'
import { markBoardDeliveryDelivered, pendingBoardDelivery } from './board-push-service.ts'
import { BOARD_DELIVERY_MAX_MESSAGES } from './board-render.ts'
import { acknowledgeNotice, postNotice } from './board-service.ts'
import { askQuestion, replyToThread } from './board-thread-service.ts'

const interruptHook = resolve(import.meta.dir, '../../hooks/board-interrupt.py')
const guardHook = resolve(import.meta.dir, '../../hooks/board-ack-guard.py')
const postingCwd = resolve(import.meta.dir, '../../..')
const hookRoots: string[] = []

function ensurePostingProject() {
  db()
    .query(`INSERT OR IGNORE INTO project(name,path,settings) VALUES ('push-project',?,'{}')`)
    .run(postingCwd)
}

afterEach(() => {
  for (const root of hookRoots.splice(0)) rmSync(root, { recursive: true, force: true })
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
    CREATE TABLE board_message(id INTEGER,kind TEXT,ack_required INTEGER,withdrawn_at TEXT,expires_at TEXT,author_session TEXT);
    CREATE TABLE board_receipt(message_id INTEGER,reader_session TEXT,delivered_at TEXT,acknowledged_at TEXT);
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
        : `#!/bin/sh\nif [ "$2" = "pending" ]; then printf x >> '${invocationLog}'; printf '%s\\n' '${commandOutput}'; fi\n`,
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
    `#!/bin/sh\nif [ "$2" = "pending" ]; then printf x >> '${fixture.invocationLog}'; printf '%s\\n' '${output}'; fi\n`,
  )
  chmodSync(fixture.command, 0o700)
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
      BOARD_PUSH_RETRY_SECONDS: '15',
      BOARD_ACK_STOP_BLOCKS: '3',
      BOARD_PUSH_SLOW_TIMEOUT_SECONDS: '5',
      ORCH_BOARD_HOOK_STATE: join(fixture.root, 'board-hook-state'),
      ...extra,
    },
  })
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
  const runner = [
    'import contextlib, importlib.util, io, json, os, sys',
    'sys.path.insert(0, os.path.dirname(sys.argv[1]))',
    'spec = importlib.util.spec_from_file_location("board_hook_test", sys.argv[1])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'pending_values = json.loads(sys.argv[4])',
    'if pending_values is not None:',
    '    pending_iterator = iter(pending_values)',
    '    module.pending = lambda session, recently_injected=None: (lambda value: (value, None, [item for item in value if item["requiresAcknowledgement"]]))(next(pending_iterator))',
    '    module.mark_delivered = lambda session, ids: None',
    'results = []',
    'for _ in range(int(sys.argv[3])):',
    '    output = io.StringIO()',
    '    sys.stdin = io.StringIO(sys.argv[2])',
    '    with contextlib.redirect_stdout(output): module.main()',
    '    results.append(output.getvalue())',
    'print(json.dumps(results))',
  ].join('\n')
  const result = Bun.spawnSync(
    ['python3', '-c', runner, path, payload, String(times), JSON.stringify(pendingValues)],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        ORCH_RUN_ID: '',
        ORCH_DB: fixture.databasePath,
        ORCH_BOARD_BIN: fixture.command,
        BOARD_PUSH_REFRESH_SECONDS: '60',
        BOARD_PUSH_REMIND_SECONDS: '300',
        BOARD_PUSH_RETRY_SECONDS: '15',
        BOARD_ACK_STOP_BLOCKS: '3',
        BOARD_PUSH_SLOW_TIMEOUT_SECONDS: '5',
        ORCH_BOARD_HOOK_STATE: join(fixture.root, 'board-hook-state'),
      },
    },
  )
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString()) as string[]
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

test('pending acknowledgement resolution combines local and hosted cache and excludes acknowledged or unaddressed notices', async () => {
  const clock = Date.parse('2026-10-07T12:00:00.000Z')
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
     VALUES ('push-reader','claude-code','architect','test','push-project','/tmp',NULL,?,?)`,
    )
    .run(new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const local = postNotice(
    {
      audience: 'project:push-project',
      title: 'Local',
      body: 'Local body',
      ackRequired: true,
    },
    {},
    clock,
  )
  const acknowledged = postNotice(
    {
      audience: 'project:push-project',
      title: 'Done',
      body: 'Done body',
      ackRequired: true,
    },
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
    origin: {
      kind: 'operator',
      session: null,
      harness: null,
      project: null,
      runId: null,
    },
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

  const pending = await pendingBoardDelivery({
    session: 'push-reader',
    budgetMs: 1,
    clock: clock + 3,
  })
  expect(pending.delivery.map((notice) => notice.id).sort()).toEqual(
    [String(local.id), hosted.id].sort(),
  )
})

test('an architect may address architects without receiving its own post', async () => {
  ensurePostingProject()
  const clock = Date.parse('2026-10-07T13:00:00.000Z')
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES ('posting-reader','claude-code','architect','test','push-project','/tmp',NULL,?,?)`,
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
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES ('claim-holder','claude-code','architect','test','push-project','/tmp',NULL,?,?)`,
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
        `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
         VALUES (?,'claude-code','architect','test','push-project','/tmp',NULL,?,?)`,
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
    String(ordinary.id),
    String(question.id),
  ])
  await markBoardDeliveryDelivered({
    session: 'delivery-reader',
    ids: first.delivery.map((message) => message.id),
    clock: clock + 2,
  })
  replyToThread(
    question.id,
    'reader participated',
    { CLAUDE_CODE_SESSION_ID: 'delivery-reader' },
    clock + 3,
    postingCwd,
  )
  const reply = replyToThread(
    question.id,
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
  expect(second.delivery.map((message) => message.id)).toEqual([String(reply.id)])
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
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test','push-project','/tmp',NULL,?,?)`,
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
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
     VALUES ('remind-reader','claude-code','architect','test','remind-project','/tmp',NULL,?,?)`,
    )
    .run(new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const posted = postNotice(
    {
      audience: 'project:remind-project',
      title: 'Reminder',
      body: 'Remember',
      ackRequired: true,
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
  expect((await claim(clock + 1)).delivery.map((notice) => notice.id)).toEqual([String(posted.id)])
  await markBoardDeliveryDelivered({
    session: 'remind-reader',
    ids: [String(posted.id)],
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
    .query('SELECT delivered_at FROM board_receipt WHERE message_id=? AND reader_session=?')
    .get(posted.id, 'remind-reader') as { delivered_at: string }
  expect((await claim(clock + 299_999)).pendingAcknowledgements.map((notice) => notice.id)).toEqual(
    [String(posted.id)],
  )
  expect((await claim(clock + 299_999)).delivery.map((notice) => notice.id)).toEqual([
    String(posted.id),
  ])
  expect((await claim(clock + 300_001)).pendingAcknowledgements.map((notice) => notice.id)).toEqual(
    [String(posted.id)],
  )
  expect(
    db()
      .query('SELECT delivered_at FROM board_receipt WHERE message_id=? AND reader_session=?')
      .get(posted.id, 'remind-reader'),
  ).toEqual(first)
})

test('recent reminders are removed before bounding without changing pending acknowledgements', async () => {
  const clock = Date.parse('2026-10-08T12:30:00.000Z')
  const session = 'bounded-reminder-reader'
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test','push-project','/tmp',NULL,?,?)`,
    )
    .run(session, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const reminders = Array.from({ length: BOARD_DELIVERY_MAX_MESSAGES }, (_, index) =>
    postNotice(
      {
        audience: `session:${session}`,
        title: `Reminder ${index}`,
        body: 'Remember',
        ackRequired: true,
      },
      {},
      clock + index,
    ),
  )
  await markBoardDeliveryDelivered({
    session,
    ids: reminders.map((notice) => String(notice.id)),
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
    recentlyInjectedIds: reminders.map((notice) => String(notice.id)),
    clock: clock + 12,
  })

  expect(result.delivery.map((notice) => notice.id)).toEqual([String(ordinary.id)])
  expect(result.pendingAcknowledgements.map((notice) => notice.id)).toEqual(
    reminders.map((notice) => String(notice.id)),
  )
})

test('recently-injected ids do not suppress messages never delivered to the session', async () => {
  const clock = Date.parse('2026-10-08T12:45:00.000Z')
  const session = 'unread-reminder-reader'
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,first_seen,last_seen)
       VALUES (?,'claude-code','architect','test','push-project','/tmp',NULL,?,?)`,
    )
    .run(session, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const unread = postNotice(
    {
      audience: `session:${session}`,
      title: 'Unread acknowledgement',
      body: 'Must still arrive',
      ackRequired: true,
    },
    {},
    clock,
  )

  const result = await pendingBoardDelivery({
    session,
    budgetMs: 0,
    includeAcknowledgementReminders: true,
    recentlyInjectedIds: [String(unread.id)],
    clock: clock + 1,
  })

  expect(result.delivery.map((notice) => notice.id)).toEqual([String(unread.id)])
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

test('PostToolUse injects pending text and fails open on command timeout or malformed output', () => {
  const item = createHookFixture(hookOutput)
  addCandidate(item, 1)
  const result = runHook(interruptHook, JSON.stringify({ session_id: 'reader' }), item)
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString()).hookSpecificOutput).toEqual({
    hookEventName: 'PostToolUse',
    additionalContext: JSON.parse(hookOutput).delivery[0].text,
  })

  const slow = createHookFixture(hookOutput, 'timeout')
  addCandidate(slow, 1)
  const timed = runHook(interruptHook, JSON.stringify({ session_id: 'reader' }), slow, {
    BOARD_PUSH_SLOW_TIMEOUT_SECONDS: '0.1',
  })
  expect(timed.exitCode).toBe(0)
  expect(timed.stdout.toString()).toBe('')

  const malformed = createHookFixture('{')
  addCandidate(malformed, 1)
  const broken = runHook(interruptHook, JSON.stringify({ session_id: 'reader' }), malformed)
  expect(broken.exitCode).toBe(0)
  expect(broken.stdout.toString()).toBe('')
})

test('PostToolUse checks an unaddressed candidate only once until a new id arrives', () => {
  const item = createHookFixture('{"delivery":[],"overflow":null,"pendingAcknowledgements":[]}')
  addCandidate(item, 1)
  const payload = JSON.stringify({ session_id: 'reader' })
  runHookRepeated(interruptHook, payload, item, 2)
  expect(invocationCount(item)).toBe(1)

  addCandidate(item, 2)
  runHook(interruptHook, payload, item)
  expect(invocationCount(item)).toBe(2)
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
    .query("INSERT INTO board_receipt VALUES (7,'reader',?,NULL)")
    .run(new Date().toISOString())
  item.database.query('UPDATE board_message SET ack_required=0 WHERE id=8').run()
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
  expect(invocations[1]).toBe('board delivered 8 --session reader')
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

test('Stop blocks three times and allows the fourth with a system message', () => {
  const item = createHookFixture(hookOutput)
  const pendingValues = Array.from({ length: 4 }, () => JSON.parse(hookOutput).delivery)
  const values = runHookRepeated(
    guardHook,
    JSON.stringify({ session_id: 'reader' }),
    item,
    4,
    pendingValues,
  ).map((value) => JSON.parse(value))
  expect(values.slice(0, 3).every((value) => value.decision === 'block')).toBe(true)
  expect(values[0].reason).toStartWith('This architect session has 1 unacknowledged board notice.')
  expect(values[3].systemMessage).toStartWith(
    'This architect session is stopping with 1 unacknowledged board notice.',
  )
})

test('Stop ignores ordinary delivery while retaining acknowledgement-required notices', () => {
  const item = createHookFixture(hookOutput)
  const values = runHookRepeated(guardHook, JSON.stringify({ session_id: 'reader' }), item, 1, [
    [
      { id: '1', text: 'ordinary', requiresAcknowledgement: false },
      { id: '2', text: 'required', requiresAcknowledgement: true },
    ],
  ])
  const result = JSON.parse(values[0]!)
  expect(result.decision).toBe('block')
  expect(result.reason).toContain('required')
  expect(result.reason).not.toContain('ordinary')
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
