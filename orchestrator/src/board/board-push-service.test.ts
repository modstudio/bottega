import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  addCandidate,
  createHookFixture,
  hookOutput,
  invocationCount,
  presenceArgs,
  presenceCallCount,
  removeHookFixtures,
  runHook,
  runHookRepeated,
  runHookRepeatedResult,
  setCommandOutput,
  writeTranscript,
} from '../../test/fixtures/board-hook.ts'
import { installRecordApiClient } from '../../test/fixtures/record-api.ts'
import { db, SESSION_LIVE_MS } from '../database/db.ts'
import { takeClaim } from './board-claim-service.ts'
import { WITHDRAWAL_SUPERSESSION_GRACE_MS } from './board-push-policy.ts'
import { markBoardDeliveryDelivered, pendingBoardDelivery } from './board-push-service.ts'
import { BOARD_DELIVERY_MAX_MESSAGES, renderBoardNoticeOneLine } from './board-render.ts'
import { postNotice } from './board-service.ts'
import { renderBoardReplyDelivery } from './board-thread-render.ts'
import { askQuestion, replyToThread } from './board-thread-service.ts'

const interruptHook = resolve(import.meta.dir, '../../hooks/board-interrupt.py')
const guardHook = resolve(import.meta.dir, '../../hooks/board-ack-guard.py')
const postingCwd = resolve(import.meta.dir, '../../..')

function ensurePostingProject() {
  db()
    .query(
      `INSERT OR IGNORE INTO project(record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'push-project',?,'{}')`,
    )
    .run(postingCwd)
}

afterEach(() => {
  removeHookFixtures()
  installRecordApiClient(null)
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
  expect(text(String(ordinary.number))).toBe(
    renderBoardNoticeOneLine({
      id: ordinary.number,
      title: 'Ordinary',
      sender: 'operator',
      ackRequired: false,
    }),
  )
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
  expect(second.delivery[0]!.text).toBe(
    renderBoardReplyDelivery({
      origin: 'architect thread-author (claude-code, push-project)',
      rootId: question.recordId,
      rootTitle: 'Question',
      body: 'author followed up',
    }),
  )
  expect(second.delivery[0]!.text).not.toContain('question body')
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

test('a successor claim receipt is stamped only by the push acknowledgement', async () => {
  ensurePostingProject()
  const clock = Date.parse('2026-10-16T12:00:00.000Z')
  const postedAtMs = clock - SESSION_LIVE_MS - 60_000
  const replyAt = postedAtMs + 30_000
  const iso = (ms: number) => new Date(ms).toISOString()
  const putPresence = db().query(
    `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
     VALUES (?,'claude-code','architect','test','push-project',(SELECT record_id FROM project WHERE name='push-project'),'/tmp',NULL,?,?)`,
  )
  putPresence.run('successor-author', iso(postedAtMs - 1_000), iso(postedAtMs))
  const posted = postNotice(
    {
      audience: 'session:successor-author',
      title: 'Report',
      body: 'The work is blocked.',
      purpose: 'request',
    },
    { CLAUDE_CODE_SESSION_ID: 'successor-author' },
    postedAtMs,
    postingCwd,
  )
  db()
    .query('UPDATE presence SET last_seen=? WHERE session_id=?')
    .run(iso(postedAtMs), 'successor-author')
  const reply = replyToThread(posted.recordId, 'The ruling is in.', {}, replyAt, postingCwd)
  putPresence.run('successor-later', iso(replyAt + 1_000), iso(clock))
  const receipt = () =>
    db()
      .query(
        'SELECT successor,delivered_at FROM board_receipt WHERE message_record_id=? AND reader_session=?',
      )
      .get(reply.recordId, 'successor-later') as { successor: number; delivered_at: string | null }

  const first = await pendingBoardDelivery({ session: 'successor-later', budgetMs: 0, clock })
  expect(first.delivery.map((message) => message.id)).toEqual([String(reply.number)])
  expect(receipt()).toEqual({ successor: 1, delivered_at: null })

  await markBoardDeliveryDelivered({
    session: 'successor-later',
    ids: first.delivery.map((message) => message.id),
    clock: clock + 1,
  })
  const stamped = receipt()
  expect(stamped.successor).toBe(1)
  expect(stamped.delivered_at).not.toBeNull()

  const next = await pendingBoardDelivery({
    session: 'successor-later',
    budgetMs: 0,
    clock: clock + 2,
  })
  expect(next.delivery).toEqual([])
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
      body: 'hosted reply body',
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
  expect(first.delivery[2]!.text).toBe(
    renderBoardReplyDelivery({
      origin: 'architect other (claude-code, unknown project)',
      rootId,
      rootTitle: 'Hosted',
      body: 'hosted reply body',
    }),
  )
  expect(first.delivery[2]!.text).not.toContain(': hosted body')
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
  const policy = readFileSync(resolve(import.meta.dir, 'board-push-policy.ts'), 'utf8')
  expect(hook).toContain('Broad prefilter for board-push-service.ts, the eligibility owner.')
  for (const [hookClause, ownerClause] of [
    ["m.kind='notice'", "row.kind === 'notice'"],
    ['m.ack_required=1', 'row.ack_required === 1'],
    ['m.author_session<>?', 'row.author_session !== session'],
    ['r.acknowledged_at IS NOT NULL', 'receipt.acknowledged_at === null'],
    ["m.kind='notice'", "message.kind === 'notice'"],
    ["json_extract(m.payload,'$.ackRequired')=1", 'message.ackRequired'],
    ["json_extract(m.payload,'$.authorSession')<>?", 'message.authorSession !== session'],
    ['later.author_session IS m.author_session', 'root.authorSession === withdrawn.authorSession'],
    ["instr(m.title, ':')>0", 'withdrawalSupersessionPrefix(withdrawn.title)'],
    [
      'julianday(later.created_at)>julianday(m.created_at)',
      'Date.parse(root.createdAt) > Date.parse(withdrawn.createdAt)',
    ],
    [
      'later_receipt.message_record_id=later.record_id',
      'localReceiptProvesReach(database, root.row.record_id, session)',
    ],
    [
      "json_extract(later.payload,'$.authorSession')",
      'root.authorSession === withdrawn.authorSession',
    ],
    [
      "instr(json_extract(m.payload,'$.title'), ':')>0",
      'withdrawalSupersessionPrefix(withdrawn.title)',
    ],
    [
      "julianday(json_extract(later.payload,'$.createdAt'))",
      'Date.parse(root.createdAt) > Date.parse(withdrawn.createdAt)',
    ],
    [
      'later_receipt.message_id=later.id',
      'hostedReceiptProvesReach(database, root.row.message.id, session)',
    ],
    ['later_receipt.audience_at_posting=1', 'audience_at_posting=1 OR delivered_at IS NOT NULL'],
  ] as const) {
    expect(hook).toContain(hookClause)
    expect(`${owner}\n${policy}`).toContain(ownerClause)
  }
  const graceLiterals = [...hook.matchAll(/WITHDRAWAL_SUPERSESSION_GRACE_DAYS\s*=\s*([\d.]+)/g)]
  expect(graceLiterals).toHaveLength(1)
  for (const literal of graceLiterals)
    expect(Number(literal[1])).toBeCloseTo(WITHDRAWAL_SUPERSESSION_GRACE_MS / 86_400_000, 15)
  expect(hook.match(/WITHDRAWAL_SUPERSESSION_GRACE_DAYS/g)).toHaveLength(3)
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
    ['{}', { BOTTEGA_RUN_ID: '9' }],
    ['{', {}],
    ['{}', { BOTTEGA_ORCHESTRATOR_DB: join(item.root, 'missing.db') }],
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

test('PostToolUse injects a pending reply with its escaped body and root context', async () => {
  ensurePostingProject()
  const clock = Date.parse('2026-10-07T18:00:00.000Z')
  for (const session of ['hook-reply-reader', 'hook-thread-author'])
    db()
      .query(
        `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,first_seen,last_seen)
         VALUES (?,'claude-code','architect','test','push-project',(SELECT record_id FROM project WHERE name='push-project'),'/tmp',NULL,?,?)`,
      )
      .run(session, new Date(clock - 1_000).toISOString(), new Date(clock).toISOString())
  const question = askQuestion(
    {
      audience: 'session:hook-reply-reader',
      title: 'Hook thread title',
      body: 'root body must not be pushed',
    },
    { CLAUDE_CODE_SESSION_ID: 'hook-thread-author' },
    clock,
    postingCwd,
  )
  const first = await pendingBoardDelivery({
    session: 'hook-reply-reader',
    budgetMs: 0,
    clock: clock + 1,
  })
  await markBoardDeliveryDelivered({
    session: 'hook-reply-reader',
    ids: first.delivery.map((message) => message.id),
    clock: clock + 1,
  })
  replyToThread(
    question.recordId,
    'reader participated',
    { CLAUDE_CODE_SESSION_ID: 'hook-reply-reader' },
    clock + 2,
    postingCwd,
  )
  const reply = replyToThread(
    question.recordId,
    'reply first line\nreply second line\tcontrolled\u0000',
    { CLAUDE_CODE_SESSION_ID: 'hook-thread-author' },
    clock + 3,
    postingCwd,
  )
  const pending = await pendingBoardDelivery({
    session: 'hook-reply-reader',
    budgetMs: 0,
    clock: clock + 4,
  })
  expect(pending.delivery.map((message) => message.id)).toEqual([String(reply.number)])
  const text = pending.delivery[0]!.text
  expect(text).toContain('Reply on "Hook thread title"')
  expect(text).toContain(`(thread ${question.recordId})`)
  expect(text).toContain('"reply first line reply second line\\tcontrolled\\u0000"')
  expect(text).not.toContain('\n')
  expect(text).not.toContain('root body must not be pushed')

  const output = JSON.stringify(pending)
  const item = createHookFixture(output)
  addCandidate(item, 1)
  const result = runHook(interruptHook, JSON.stringify({ session_id: 'hook-reply-reader' }), item)
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString()).hookSpecificOutput.additionalContext).toBe(text)
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
      "INSERT INTO board_receipt(message_record_id,reader_session,delivered_at,acknowledged_at) SELECT record_id,'reader',?,NULL FROM board_message WHERE number=7",
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
