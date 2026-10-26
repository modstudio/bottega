import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { fixtureProjectRecordId } from '../database/test-database.fixture.ts'
import { projectAt } from '../project/projects.ts'
import { claimNotices, claimRunNotices, reapBoardMessages } from './board-service.ts'
import { BOARD_NOTE_FILING_LEASE_MS } from './board-thread-policy.ts'
import {
  acceptAnswer,
  askQuestion,
  fileAnswerNote,
  readThread,
  replyToThread,
} from './board-thread-service.ts'

const cwd = resolve(import.meta.dir, '../../..')

function ensurePostingProject() {
  db()
    .query(
      `INSERT OR IGNORE INTO project(record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),'thread-fixture',?,'{}')`,
    )
    .run(cwd)
  if (!projectAt(cwd)) throw new Error('thread test posting project did not resolve')
}

function addArchitect(session: string, project: string, clock: number) {
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,project_record_id,cwd,current_task_key,last_seen)
       VALUES (?,'claude-code','architect','test',?,(SELECT record_id FROM project WHERE name=?),?,NULL,?)`,
    )
    .run(session, project, project, cwd, new Date(clock).toISOString())
}

const architect = (session: string) => ({ CLAUDE_CODE_SESSION_ID: session })
const filed = (number: number) => ({
  noteRecordId: `01990000-0000-7000-8000-${String(number).padStart(12, '0')}`,
  noteLabel: `thread-fixture#${number}`,
})

test('question replies reach the prior participants but never the replier', () => {
  ensurePostingProject()
  const clock = Date.now() + 100_000
  const project = 'thread-participants'
  addArchitect('thread-first', project, clock)
  addArchitect('thread-second', project, clock)
  const question = askQuestion(
    { audience: `project:${project}`, title: 'How?', body: 'What should happen?' },
    {},
    clock,
  )
  const first = replyToThread(
    question.recordId,
    'First answer',
    architect('thread-first'),
    clock + 1,
    cwd,
  )
  expect(first.reached).toBe(1)
  expect(
    claimNotices(false, architect('thread-first'), clock + 2).map((row) => row.recordId),
  ).not.toContain(first.recordId)
  expect(claimNotices(false, {}, clock + 2).map((row) => row.recordId)).toContain(first.recordId)

  const second = replyToThread(
    question.recordId,
    'Second answer',
    architect('thread-second'),
    clock + 3,
    cwd,
  )
  expect(second.reached).toBe(2)
  expect(claimNotices(false, {}, clock + 4).map((row) => row.recordId)).toContain(second.recordId)
  expect(
    claimNotices(false, architect('thread-first'), clock + 4).map((row) => row.recordId),
  ).toContain(second.recordId)
})

test('reply receipts select acknowledged readers or the root audience', () => {
  ensurePostingProject()
  const clock = Date.now() + 150_000
  const project = 'thread-selected-audience'
  for (const session of ['selected-asker', 'selected-replier'])
    addArchitect(session, project, clock)
  const question = askQuestion(
    {
      audience: `project:${project}`,
      title: 'Who should receive this?',
      body: 'Select readers from the root receipts.',
    },
    architect('selected-asker'),
    clock,
    cwd,
  )
  db().query('DELETE FROM board_receipt WHERE message_record_id=?').run(question.recordId)
  const addRootReceipt = db().query(
    `INSERT INTO board_receipt
     (record_id,message_record_id,reader_session,audience_at_posting,delivered_at,acknowledged_at)
     VALUES (?,?,?,?,NULL,?)`,
  )
  addRootReceipt.run(
    newRecordId(),
    question.recordId,
    'acknowledged-reader',
    0,
    new Date(clock + 1).toISOString(),
  )
  addRootReceipt.run(newRecordId(), question.recordId, 'root-audience-reader', 1, null)

  const acknowledged = replyToThread(
    question.recordId,
    'Acknowledged readers only',
    architect('selected-replier'),
    clock + 2,
    cwd,
    { kind: 'acknowledged' },
  )
  const rootAudience = replyToThread(
    question.recordId,
    'Original audience only',
    architect('selected-replier'),
    clock + 3,
    cwd,
    { kind: 'audience' },
  )
  const readers = (messageId: string) =>
    (
      db()
        .query(
          'SELECT reader_session FROM board_receipt WHERE message_record_id=? ORDER BY reader_session',
        )
        .all(messageId) as Array<{ reader_session: string }>
    ).map((row) => row.reader_session)

  expect(readers(acknowledged.recordId)).toEqual(['acknowledged-reader', 'selected-asker'])
  expect(readers(rootAudience.recordId)).toEqual(['root-audience-reader', 'selected-asker'])
})

test('an explicit reply recipient is looped into the thread and can read and reply', () => {
  ensurePostingProject()
  const clock = Date.now() + 175_000
  const project = 'thread-explicit-reach'
  for (const session of ['reach-asker', 'reach-replier', 'reach-inside'])
    addArchitect(session, project, clock)
  const question = askQuestion(
    {
      audience: `project:${project}`,
      title: 'Can this reply narrow?',
      body: 'Loop another session into this thread.',
    },
    architect('reach-asker'),
    clock,
    cwd,
  )

  const accepted = replyToThread(
    question.recordId,
    'Address the in-reach reader',
    architect('reach-replier'),
    clock + 1,
    cwd,
    { kind: 'session', sessionId: 'reach-inside' },
  )
  expect(
    db()
      .query(
        'SELECT reader_session FROM board_receipt WHERE message_record_id=? ORDER BY reader_session',
      )
      .all(accepted.recordId),
  ).toEqual([{ reader_session: 'reach-asker' }, { reader_session: 'reach-inside' }])
  const looped = replyToThread(
    question.recordId,
    'Loop in the new participant',
    architect('reach-replier'),
    clock + 2,
    cwd,
    { kind: 'session', sessionId: 'reach-outside' },
  )
  expect(
    db()
      .query(
        'SELECT reader_session FROM board_receipt WHERE message_record_id=? ORDER BY reader_session',
      )
      .all(looped.recordId),
  ).toEqual([{ reader_session: 'reach-asker' }, { reader_session: 'reach-outside' }])
  const received = claimNotices(false, architect('reach-outside'), clock + 3).find(
    (notice) => notice.recordId === looped.recordId,
  )
  expect(received?.text).toContain(`Thread: ${question.recordId}`)
  expect(readThread(question.recordId, architect('reach-outside'), clock + 3).replies).toHaveLength(
    2,
  )
  const participantReply = replyToThread(
    question.recordId,
    'Reply as a participant',
    architect('reach-outside'),
    clock + 4,
    cwd,
    { kind: 'participants' },
  )
  expect(
    db()
      .query(
        'SELECT reader_session FROM board_receipt WHERE message_record_id=? ORDER BY reader_session',
      )
      .all(participantReply.recordId),
  ).toEqual([
    { reader_session: 'reach-asker' },
    { reader_session: 'reach-inside' },
    { reader_session: 'reach-replier' },
  ])
})

test('identical reply bodies with different audiences are stored separately', () => {
  ensurePostingProject()
  const clock = Date.now() + 185_000
  const project = 'thread-audience-duplicates'
  for (const session of ['duplicate-asker', 'duplicate-replier'])
    addArchitect(session, project, clock)
  const question = askQuestion(
    { audience: `project:${project}`, title: 'Same body?', body: 'Preserve both choices.' },
    architect('duplicate-asker'),
    clock,
    cwd,
  )
  const first = replyToThread(
    question.recordId,
    'Identical body',
    architect('duplicate-replier'),
    clock + 1,
    cwd,
    { kind: 'participants' },
  )
  const second = replyToThread(
    question.recordId,
    'Identical body',
    architect('duplicate-replier'),
    clock + 2,
    cwd,
    { kind: 'acknowledged' },
  )
  expect(first.recordId).not.toBe(second.recordId)
  expect(
    db()
      .query('SELECT audience FROM board_message WHERE record_id IN (?,?) ORDER BY created_at')
      .all(first.recordId, second.recordId),
  ).toEqual([{ audience: 'participants' }, { audience: 'acknowledged' }])
  expect(
    db()
      .query(
        'SELECT message_record_id,reader_session FROM board_receipt WHERE message_record_id IN (?,?) ORDER BY message_record_id,reader_session',
      )
      .all(first.recordId, second.recordId),
  ).toEqual([
    { message_record_id: first.recordId, reader_session: 'duplicate-asker' },
    { message_record_id: second.recordId, reader_session: 'duplicate-asker' },
  ])
})

test('questions are withheld from run readers and architect broadcasts reject non-author replies', () => {
  ensurePostingProject()
  fixtureProjectRecordId(db())
  const clock = Date.now() + 200_000
  const run = db()
    .query(
      `INSERT INTO run
       (record_id,number,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,turn,project_record_id)
       VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),?,'codex','implement','thread-workers','sha',1,'prompt','running',1,
               (SELECT record_id FROM project ORDER BY name LIMIT 1)) RETURNING record_id AS id`,
    )
    .get(new Date(clock).toISOString()) as { id: string }
  const workerQuestion = askQuestion(
    { audience: 'project:thread-workers', title: 'Architect only', body: 'Workers cannot answer.' },
    {},
    clock,
  )
  expect(claimRunNotices(run.id, true, clock + 1)).toEqual([])
  addArchitect('broadcast-reader', 'thread-broadcast', clock + 20_000)
  const broadcast = askQuestion(
    { audience: 'architects', title: 'Broadcast', body: 'Acknowledge this.' },
    {},
    clock + 20_000,
  )
  expect(() =>
    replyToThread(
      broadcast.recordId,
      'Should not post',
      architect('broadcast-reader'),
      clock + 20_001,
      cwd,
    ),
  ).toThrow(/broadcast/)
  expect(workerQuestion.reached).toBe(0)
})

test('acceptance closes a question, persists through filing failure, and retry files once', async () => {
  ensurePostingProject()
  const clock = Date.now() + 300_000
  const project = 'thread-acceptance'
  addArchitect('question-asker', project, clock)
  addArchitect('question-answerer', project, clock)
  const question = askQuestion(
    { audience: `project:${project}`, title: 'Choose', body: 'Which answer?' },
    architect('question-asker'),
    clock,
    cwd,
  )
  const reply = replyToThread(
    question.recordId,
    'The accepted answer',
    architect('question-answerer'),
    clock + 1,
    cwd,
  )
  const failed = await acceptAnswer(
    question.recordId,
    reply.recordId,
    architect('question-asker'),
    clock + 2,
    cwd,
    async () => {
      throw new Error('hub unavailable')
    },
  )
  expect(failed.notePendingError).toBe('hub unavailable')
  expect(readThread(question.recordId, architect('question-asker'), clock + 3).root).toMatchObject({
    state: 'accepted',
    acceptedReplyId: reply.recordId,
    noteRecordId: null,
    noteLabel: null,
    notePendingError: 'hub unavailable',
  })
  expect(() =>
    replyToThread(question.recordId, 'Too late', architect('question-answerer'), clock + 4, cwd),
  ).toThrow(/accepted answer/)
  await expect(
    acceptAnswer(
      question.recordId,
      reply.recordId,
      architect('question-asker'),
      clock + 5,
      cwd,
      async () => ({
        ...filed(99),
      }),
    ),
  ).rejects.toThrow(/acceptance is final/)
  const retried = await fileAnswerNote(
    question.recordId,
    architect('question-asker'),
    cwd,
    async ({ text }) => {
      expect(text).toContain('Choose: The accepted answer')
      return filed(99)
    },
  )
  expect(retried.noteLabel).toBe('thread-fixture#99')
  await expect(
    fileAnswerNote(question.recordId, architect('question-answerer'), cwd, async () => filed(100)),
  ).rejects.toThrow(/question author or operator/)
  await expect(
    fileAnswerNote(question.recordId, architect('question-asker'), cwd, async () => filed(100)),
  ).rejects.toThrow(/already filed note thread-fixture#99/)
})

test('only the asker or operator accepts and the reply must belong to the question', async () => {
  ensurePostingProject()
  const clock = Date.now() + 400_000
  const project = 'thread-accept-permission'
  for (const session of ['permission-asker', 'permission-answerer', 'permission-other'])
    addArchitect(session, project, clock)
  const question = askQuestion(
    { audience: `project:${project}`, title: 'Permission', body: 'Who accepts?' },
    architect('permission-asker'),
    clock,
    cwd,
  )
  const otherQuestion = askQuestion(
    { audience: `project:${project}`, title: 'Other', body: 'Other thread.' },
    architect('permission-asker'),
    clock + 1,
    cwd,
  )
  const reply = replyToThread(
    question.recordId,
    'Answer',
    architect('permission-answerer'),
    clock + 2,
    cwd,
  )
  await expect(
    acceptAnswer(
      question.recordId,
      reply.recordId,
      architect('permission-other'),
      clock + 3,
      cwd,
      async () => filed(1),
    ),
  ).rejects.toThrow(/question author/)
  await expect(
    acceptAnswer(
      otherQuestion.recordId,
      reply.recordId,
      architect('permission-asker'),
      clock + 4,
      cwd,
      async () => filed(1),
    ),
  ).rejects.toThrow(/does not belong/)
})

test('accepted threads survive retention while unaccepted expired questions are reaped', async () => {
  ensurePostingProject()
  const clock = Date.now() + 500_000
  const project = 'thread-retention'
  addArchitect('retention-answerer', project, clock)
  const accepted = askQuestion(
    { audience: `project:${project}`, title: 'Keep', body: 'Keep this.', expiresMs: 1 },
    {},
    clock,
  )
  const reply = replyToThread(
    accepted.recordId,
    'Durable answer',
    architect('retention-answerer'),
    clock,
    cwd,
  )
  await acceptAnswer(accepted.recordId, reply.recordId, {}, clock, cwd, async () => filed(101))
  const expired = askQuestion(
    { audience: `project:${project}`, title: 'Reap', body: 'Reap this.', expiresMs: 1 },
    {},
    clock + 20_000,
  )
  reapBoardMessages(clock + 20_000 + 15 * 24 * 60 * 60 * 1_000)
  expect(
    db().query('SELECT record_id FROM board_message WHERE record_id=?').get(accepted.recordId),
  ).toBeDefined()
  expect(
    db().query('SELECT record_id FROM board_message WHERE record_id=?').get(reply.recordId),
  ).toBeDefined()
  expect(
    db().query('SELECT record_id FROM board_message WHERE record_id=?').get(expired.recordId),
  ).toBeNull()
})

test('a retry while acceptance is filing is refused and files exactly one note', async () => {
  ensurePostingProject()
  const clock = Date.now() + 600_000
  const project = 'thread-filing-lease'
  addArchitect('lease-asker', project, clock)
  addArchitect('lease-answerer', project, clock)
  const question = askQuestion(
    { audience: `project:${project}`, title: 'Lease', body: 'File once?' },
    architect('lease-asker'),
    clock,
    cwd,
  )
  const reply = replyToThread(
    question.recordId,
    'Only once',
    architect('lease-answerer'),
    clock + 1,
    cwd,
  )
  let release!: () => void
  let signalStarted!: () => void
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  const waitForRelease = new Promise<void>((resolve) => {
    release = resolve
  })
  let filings = 0
  const accepting = acceptAnswer(
    question.recordId,
    reply.recordId,
    architect('lease-asker'),
    clock + 2,
    cwd,
    async () => {
      filings += 1
      signalStarted()
      await waitForRelease
      return filed(202)
    },
  )
  await started
  await expect(
    fileAnswerNote(
      question.recordId,
      architect('lease-asker'),
      cwd,
      async () => {
        filings += 1
        return filed(203)
      },
      clock + 3,
    ),
  ).rejects.toThrow(/filing is in progress.*file-note.*after/)
  release()
  expect(await accepting).toMatchObject({ noteLabel: 'thread-fixture#202', retry: null })
  expect(filings).toBe(1)
})

test('a stale note filing lease can be taken over', async () => {
  ensurePostingProject()
  const clock = Date.now() + 700_000
  const project = 'thread-stale-lease'
  addArchitect('stale-asker', project, clock)
  addArchitect('stale-answerer', project, clock)
  const question = askQuestion(
    { audience: `project:${project}`, title: 'Stale', body: 'Recover filing?' },
    architect('stale-asker'),
    clock,
    cwd,
  )
  const reply = replyToThread(
    question.recordId,
    'Recover it',
    architect('stale-answerer'),
    clock + 1,
    cwd,
  )
  await acceptAnswer(
    question.recordId,
    reply.recordId,
    architect('stale-asker'),
    clock + 2,
    cwd,
    async () => {
      throw new Error('first filing failed')
    },
  )
  db()
    .query('UPDATE board_message SET note_filing_started_at=? WHERE record_id=?')
    .run(new Date(clock + 3).toISOString(), question.recordId)
  const retried = await fileAnswerNote(
    question.recordId,
    architect('stale-asker'),
    cwd,
    async () => filed(204),
    clock + 3 + BOARD_NOTE_FILING_LEASE_MS,
  )
  expect(retried).toMatchObject({
    noteLabel: 'thread-fixture#204',
    notePendingError: null,
    retry: null,
  })
})
