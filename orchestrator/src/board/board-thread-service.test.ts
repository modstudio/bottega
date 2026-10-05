import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { db } from '../database/db.ts'
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
    .query(`INSERT OR IGNORE INTO project(name,path,settings) VALUES ('thread-fixture',?,'{}')`)
    .run(cwd)
  if (!projectAt(cwd)) throw new Error('thread test posting project did not resolve')
}

function addArchitect(session: string, project: string, clock: number) {
  db()
    .query(
      `INSERT INTO presence(session_id,harness,role,machine,project,cwd,current_task_key,last_seen)
       VALUES (?,'claude-code','architect','test',?,?,NULL,?)`,
    )
    .run(session, project, cwd, new Date(clock).toISOString())
}

const architect = (session: string) => ({ CLAUDE_CODE_SESSION_ID: session })

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
    question.id,
    'First answer',
    architect('thread-first'),
    clock + 1,
    cwd,
  )
  expect(first.reached).toBe(1)
  expect(
    claimNotices(false, architect('thread-first'), clock + 2).map((row) => row.id),
  ).not.toContain(first.id)
  expect(claimNotices(false, {}, clock + 2).map((row) => row.id)).toContain(first.id)

  const second = replyToThread(
    question.id,
    'Second answer',
    architect('thread-second'),
    clock + 3,
    cwd,
  )
  expect(second.reached).toBe(2)
  expect(claimNotices(false, {}, clock + 4).map((row) => row.id)).toContain(second.id)
  expect(claimNotices(false, architect('thread-first'), clock + 4).map((row) => row.id)).toContain(
    second.id,
  )
})

test('questions are withheld from run readers and architect broadcasts reject non-author replies', () => {
  ensurePostingProject()
  const clock = Date.now() + 200_000
  const run = db()
    .query(
      `INSERT INTO run
       (started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,turn)
       VALUES (?,'codex','implement','thread-workers','sha',1,'prompt','running',1) RETURNING id`,
    )
    .get(new Date(clock).toISOString()) as { id: number }
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
      broadcast.id,
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
    question.id,
    'The accepted answer',
    architect('question-answerer'),
    clock + 1,
    cwd,
  )
  const failed = await acceptAnswer(
    question.id,
    reply.id,
    architect('question-asker'),
    clock + 2,
    cwd,
    async () => {
      throw new Error('hub unavailable')
    },
  )
  expect(failed.notePendingError).toBe('hub unavailable')
  expect(readThread(question.id, architect('question-asker'), clock + 3).root).toMatchObject({
    state: 'accepted',
    acceptedReplyId: reply.id,
    noteId: null,
    notePendingError: 'hub unavailable',
  })
  expect(() =>
    replyToThread(question.id, 'Too late', architect('question-answerer'), clock + 4, cwd),
  ).toThrow(/accepted answer/)
  await expect(
    acceptAnswer(question.id, reply.id, architect('question-asker'), clock + 5, cwd, async () => ({
      noteId: 99,
    })),
  ).rejects.toThrow(/acceptance is final/)
  const retried = await fileAnswerNote(
    question.id,
    architect('question-asker'),
    cwd,
    async ({ text }) => {
      expect(text).toContain('Choose: The accepted answer')
      return { noteId: 99 }
    },
  )
  expect(retried.noteId).toBe(99)
  await expect(
    fileAnswerNote(question.id, architect('question-answerer'), cwd, async () => ({ noteId: 100 })),
  ).rejects.toThrow(/question author or operator/)
  await expect(
    fileAnswerNote(question.id, architect('question-asker'), cwd, async () => ({ noteId: 100 })),
  ).rejects.toThrow(/already filed note 99/)
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
    question.id,
    'Answer',
    architect('permission-answerer'),
    clock + 2,
    cwd,
  )
  await expect(
    acceptAnswer(
      question.id,
      reply.id,
      architect('permission-other'),
      clock + 3,
      cwd,
      async () => ({ noteId: 1 }),
    ),
  ).rejects.toThrow(/question author/)
  await expect(
    acceptAnswer(
      otherQuestion.id,
      reply.id,
      architect('permission-asker'),
      clock + 4,
      cwd,
      async () => ({ noteId: 1 }),
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
    accepted.id,
    'Durable answer',
    architect('retention-answerer'),
    clock,
    cwd,
  )
  await acceptAnswer(accepted.id, reply.id, {}, clock, cwd, async () => ({ noteId: 101 }))
  const expired = askQuestion(
    { audience: `project:${project}`, title: 'Reap', body: 'Reap this.', expiresMs: 1 },
    {},
    clock + 20_000,
  )
  reapBoardMessages(clock + 20_000 + 15 * 24 * 60 * 60 * 1_000)
  expect(db().query('SELECT id FROM board_message WHERE id=?').get(accepted.id)).toBeDefined()
  expect(db().query('SELECT id FROM board_message WHERE id=?').get(reply.id)).toBeDefined()
  expect(db().query('SELECT id FROM board_message WHERE id=?').get(expired.id)).toBeNull()
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
  const reply = replyToThread(question.id, 'Only once', architect('lease-answerer'), clock + 1, cwd)
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
    question.id,
    reply.id,
    architect('lease-asker'),
    clock + 2,
    cwd,
    async () => {
      filings += 1
      signalStarted()
      await waitForRelease
      return { noteId: 202 }
    },
  )
  await started
  await expect(
    fileAnswerNote(
      question.id,
      architect('lease-asker'),
      cwd,
      async () => {
        filings += 1
        return { noteId: 203 }
      },
      clock + 3,
    ),
  ).rejects.toThrow(/filing is in progress.*file-note.*after/)
  release()
  expect(await accepting).toMatchObject({ noteId: 202, retry: null })
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
    question.id,
    'Recover it',
    architect('stale-answerer'),
    clock + 1,
    cwd,
  )
  await acceptAnswer(question.id, reply.id, architect('stale-asker'), clock + 2, cwd, async () => {
    throw new Error('first filing failed')
  })
  db()
    .query('UPDATE board_message SET note_filing_started_at=? WHERE id=?')
    .run(new Date(clock + 3).toISOString(), question.id)
  const retried = await fileAnswerNote(
    question.id,
    architect('stale-asker'),
    cwd,
    async () => ({ noteId: 204 }),
    clock + 3 + BOARD_NOTE_FILING_LEASE_MS,
  )
  expect(retried).toMatchObject({ noteId: 204, notePendingError: null, retry: null })
})
