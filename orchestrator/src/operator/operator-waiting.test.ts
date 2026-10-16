import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { notificationCommand } from '../../../shared/operator-notification.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import {
  claimOperatorNotifications,
  initialQuestionWaitingAt,
  operatorWaiting,
  questionAwaitingOperator,
  relayQuestion,
} from './operator-waiting.ts'

const priorSession = process.env.CLAUDE_CODE_SESSION_ID

beforeEach(() => {
  process.env.CLAUDE_CODE_SESSION_ID = 'operator-waiting-test'
})

afterEach(() => {
  if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
  else process.env.CLAUDE_CODE_SESSION_ID = priorSession
})

function run(status = 'asking') {
  return db()
    .query(
      `INSERT INTO run
        (record_id,started_at,agent,job,repo,prompt_sha,prompt_bytes,prompt_head,status,session_id,launch_key)
       VALUES ('${newRecordId()}','2026-09-25','codex','implement','fixture','x',1,'x',?,'operator-waiting-test','DEV-943')
       RETURNING id`,
    )
    .get(status) as { id: number }
}

describe('operator waiting decision', () => {
  test('user rulings and relay wait until the question is answered', () => {
    expect(
      questionAwaitingOperator({ rulings: 'user', relayed: false, answered: false }),
    ).toBeTrue()
    expect(
      questionAwaitingOperator({ rulings: 'agent', relayed: true, answered: false }),
    ).toBeTrue()
    expect(questionAwaitingOperator({ rulings: 'user', relayed: true, answered: true })).toBeFalse()
    expect(
      questionAwaitingOperator({ rulings: 'agent', relayed: false, answered: false }),
    ).toBeFalse()
  })

  test('effective user rulings mark an inserted question as waiting', async () => {
    db()
      .query(
        'INSERT INTO project (record_id,name,path,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?)',
      )
      .run('fixture', '/fixture', JSON.stringify({ autonomy: { rulings: 'user' } }))
    const owner = run('running')
    expect(await initialQuestionWaitingAt(owner.id, '2026-09-25')).toBe('2026-09-25')
  })
})

describe('relay', () => {
  test('refuses an answered question', () => {
    const owner = run()
    const question = db()
      .query(
        `INSERT INTO question (record_id,run_id,asked_at,question,answer,answered_at)
         VALUES ('${newRecordId()}',?,'2026-09-25','Which?','This.','2026-09-25') RETURNING id`,
      )
      .get(owner.id) as { id: number }
    expect(() => relayQuestion(owner.id, question.id, 'operator must decide')).toThrow(
      `question ${question.id} is already answered`,
    )
  })

  test('is idempotent and audits the caller session', () => {
    const owner = run()
    const question = db()
      .query(
        `INSERT INTO question (record_id,run_id,asked_at,question)
         VALUES ('${newRecordId()}',?,'2026-09-25','Which?') RETURNING id`,
      )
      .get(owner.id) as { id: number }
    const noNotification = () => {}
    relayQuestion(owner.id, question.id, 'operator must decide', db(), noNotification)
    const first = db()
      .query('SELECT awaiting_operator_at,relayed_by FROM question WHERE id=?')
      .get(question.id)
    relayQuestion(owner.id, question.id, 'still needs operator', db(), noNotification)
    expect(
      db()
        .query('SELECT awaiting_operator_at,relayed_by FROM question WHERE id=?')
        .get(question.id),
    ).toEqual(first)
    expect(
      db()
        .query(
          "SELECT action,actor_session,reason FROM run_mutation_audit WHERE action='relay' ORDER BY at",
        )
        .all(),
    ).toEqual([
      { action: 'relay', actor_session: 'operator-waiting-test', reason: 'operator must decide' },
      { action: 'relay', actor_session: 'operator-waiting-test', reason: 'still needs operator' },
    ])
  })
})

test('waiting JSON model includes run questions and workflow rulings', () => {
  const owner = run()
  const question = db()
    .query(
      `INSERT INTO question
        (record_id,run_id,asked_at,question,options,recommendation,why,awaiting_operator_at)
       VALUES ('${newRecordId()}',?,'2026-09-25','Run question?', '["a","b"]','a','because','2026-09-25')
       RETURNING id`,
    )
    .get(owner.id) as { id: number }
  const cursor = db()
    .query(
      `INSERT INTO workflow_cursor
        (record_id,project,workflow_slug,mode_slug,workflow_key,instance_id,workflow_version,catalogue_version,
         args,ordinal,step_slug,state,closed,question,total_steps,created_at,updated_at,session_id)
       VALUES ('${newRecordId()}','fixture','fixture-workflow','default','DEV-943','',1,1,'{"key":"DEV-943"}',0,'rebase',
               'awaiting-ruling','[]','Workflow question?',1,'2026-09-24','2026-09-25','session-1') RETURNING id`,
    )
    .get() as { id: number }
  db()
    .query(
      `INSERT INTO question
      (record_id,workflow_cursor_id,workflow_key,asked_at,question,asked_via,awaiting_operator_at)
     VALUES ('${newRecordId()}',?,'DEV-943','2026-09-25','Workflow question?','workflow','2026-09-25')`,
    )
    .run(cursor.id)

  const waiting = operatorWaiting()
  expect(waiting).toMatchObject([
    {
      kind: 'question',
      id: question.id,
      run_id: owner.id,
      project: 'fixture',
      task_key: 'DEV-943',
      session_id: null,
      question: 'Run question?',
      options: ['a', 'b'],
      recommendation: 'a',
      why: 'because',
      waiting_since: '2026-09-25',
      episode: '2026-09-25',
      answer_command: `${PLATFORM_SLUG} question answer ${owner.id} --q${question.id} --from-operator "<ruling>"`,
    },
    {
      kind: 'workflow',
      id: cursor.id,
      run_id: null,
      project: 'fixture',
      task_key: 'DEV-943',
      session_id: 'session-1',
      question: 'Workflow question?',
      options: [],
      recommendation: null,
      why: null,
      waiting_since: '2026-09-25',
      episode: '2026-09-25',
      answer_command: `${PLATFORM_SLUG} workflow rule fixture-workflow --project fixture --mode default --arg key=DEV-943 --ruling "<ruling>" --from-operator`,
    },
  ])
  expect(waiting.every((item) => /^[0-9a-f-]{36}$/.test(item.question_record_id))).toBe(true)
  expect(waiting[0]?.run_record_id).toBe(
    (db().query('SELECT record_id FROM run WHERE id=?').get(owner.id) as { record_id: string })
      .record_id,
  )
})

test('notification claims return each waiting episode once', () => {
  const owner = run()
  const question = db()
    .query(
      `INSERT INTO question (record_id,run_id,asked_at,question,awaiting_operator_at)
       VALUES ('${newRecordId()}',?,'2026-09-25','Question?','2026-09-25') RETURNING id`,
    )
    .get(owner.id) as { id: number }
  const cursor = db()
    .query(
      `INSERT INTO workflow_cursor
        (record_id,project,workflow_slug,mode_slug,workflow_key,instance_id,workflow_version,catalogue_version,
         args,ordinal,step_slug,state,closed,question,total_steps,created_at,updated_at)
       VALUES ('${newRecordId()}','fixture','fixture-workflow','default','DEV-943','',1,1,'{}',0,'rebase','awaiting-ruling',
               '[]','Workflow?',1,'2026-09-25','2026-09-25') RETURNING id`,
    )
    .get() as { id: number }
  db()
    .query(
      `INSERT INTO question
      (record_id,workflow_cursor_id,workflow_key,asked_at,question,asked_via,awaiting_operator_at)
     VALUES ('${newRecordId()}',?,'DEV-943','2026-09-25','Workflow?','workflow','2026-09-25')`,
    )
    .run(cursor.id)
  const first = claimOperatorNotifications(db())
  expect(first.map(({ kind, id }) => ({ kind, id }))).toEqual([
    { kind: 'question', id: question.id },
    { kind: 'workflow', id: cursor.id },
  ])
  expect(first[0]?.notification).toEqual({
    title: 'Ruling needed: fixture DEV-943',
    body: 'Question?',
    link: `http://127.0.0.1:7778/inbox/question/${question.id}`,
  })
  const notificationIds = db()
    .query<{ record_id: string }, []>('SELECT record_id FROM operator_notification ORDER BY kind')
    .all()
  expect(notificationIds).toHaveLength(2)
  expect(
    notificationIds.every(({ record_id }) => /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(record_id)),
  ).toBe(true)
  expect(claimOperatorNotifications(db())).toEqual([])
  expect(
    db()
      .query<{ record_id: string }, []>('SELECT record_id FROM operator_notification ORDER BY kind')
      .all(),
  ).toEqual(notificationIds)

  db().query("UPDATE workflow_cursor SET state='running', updated_at='2026-09-26'").run()
  db()
    .query(
      "UPDATE question SET closed_at='2026-09-26',close_reason='advanced-without-ruling' WHERE workflow_cursor_id=?",
    )
    .run(cursor.id)
  db()
    .query(
      "UPDATE workflow_cursor SET state='awaiting-ruling', question='Again?', updated_at='2026-09-27'",
    )
    .run()
  db()
    .query(
      `INSERT INTO question
      (record_id,workflow_cursor_id,workflow_key,asked_at,question,asked_via,awaiting_operator_at)
     VALUES ('${newRecordId()}',?,'DEV-943','2026-09-27','Again?','workflow','2026-09-27')`,
    )
    .run(cursor.id)
  expect(
    claimOperatorNotifications(db()).map(({ kind, id, waiting_since }) => ({
      kind,
      id,
      waiting_since,
    })),
  ).toEqual([{ kind: 'workflow', id: cursor.id, waiting_since: '2026-09-27' }])
  expect(claimOperatorNotifications(db())).toEqual([])
})

test('a no-project question lists and notifies without a project label', () => {
  const owner = run()
  db().query('UPDATE run SET repo=NULL,launch_key=NULL WHERE id=?').run(owner.id)
  const question = db()
    .query(
      `INSERT INTO question (record_id,run_id,asked_at,question,awaiting_operator_at)
       VALUES ('${newRecordId()}',?,'2026-09-25','No project?','2026-09-25') RETURNING id`,
    )
    .get(owner.id) as { id: number }

  expect(operatorWaiting()).toMatchObject([{ id: question.id, project: null }])
  expect(claimOperatorNotifications(db())[0]?.notification.title).toBe('Ruling needed')
})

test('notification command prefers the platform adapter without spawning', () => {
  const all = new Set(['terminal-notifier', 'osascript', 'notify-send'])
  expect(notificationCommand('darwin', all, 'Title', 'Body', 'http://link')?.argv).toEqual([
    'terminal-notifier',
    '-title',
    'Title',
    '-message',
    'Body',
    '-open',
    'http://link',
  ])
  expect(
    notificationCommand('darwin', new Set(['osascript']), 'Title', 'Body', 'http://link')?.argv,
  ).toEqual(['osascript', '-e', 'display notification "Body http://link" with title "Title"'])
  expect(notificationCommand('linux', all, 'Title', 'Body', 'http://link')?.argv).toEqual([
    'notify-send',
    'Title',
    'Body',
  ])
  expect(notificationCommand('win32', all, 'Title', 'Body', 'http://link')).toBeNull()
})
