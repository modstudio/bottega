import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  type ContextBrief,
  contextBrief,
  holderSequence,
  renderContextBrief,
  selectBriefInFlight,
  storedBriefHolders,
  workingKeysForBrief,
} from './context-brief.ts'

const item = (
  holder: string,
  id: string,
  kind: ContextBrief['holders'][number]['items'][number]['kind'],
  body: string,
  source = 'task-doc',
) => ({ holder, id, kind, body, source })

test('renders the compact context layout line by line and keeps only item first lines', () => {
  const brief: ContextBrief = {
    session: '65fbe830',
    fullCommand: `${PLATFORM_SLUG} agent context show --task DEV-1844/2`,
    holders: [
      {
        key: '65fbe830',
        title: '',
        kind: 'session',
        items: [item('session:65fbe830', 'weekend', 'fact', 'work autonomously\rthrough Sunday')],
      },
      {
        key: 'DEV-1844/2',
        title: 'Build the brief',
        kind: 'task',
        items: [
          item('task:DEV-1844/2', 'pointer', 'pointer', 'design section 4\nignore this line'),
        ],
      },
      {
        key: 'DEV-1844',
        title: 'Architect context',
        kind: 'epic',
        items: [
          item(
            'task:DEV-1844',
            'approved',
            'ruling',
            'Approved as proposed\r\nwith detail',
            'q5282',
          ),
        ],
      },
    ],
    runs: [{ number: 31111, job: 'review', status: 'asking' }],
    cursors: [
      {
        recordId: 'cursor-record',
        number: 1369,
        workflow: 'plan-task',
        mode: 'design',
        step: 3,
        totalSteps: 7,
        stepSlug: 'design',
        questionNumber: 5277,
        runs: [31110],
      },
    ],
    claims: [{ kind: 'task', value: 'DEV-1844/2' }],
    reviewVerdictLines: [
      `DEV-1844 review: lens correctness owed → ${PLATFORM_SLUG} review tier DEV-1844-work`,
    ],
    waiting: {
      boardRequests: 2,
      questions: { worker: 0, user: 0, foreign: 0, unowned: 0 },
      filedIssues: 3,
      resumeBriefs: 1,
    },
    autonomy: 'plan review · implement, review, docs, canon auto · ship trunk',
  }

  expect(renderContextBrief(brief).split('\n')).toEqual([
    `Context (session 65fbe830) · full: ${PLATFORM_SLUG} agent context show --task DEV-1844/2`,
    'Session 65fbe830',
    '  fact: work autonomously',
    '  open: none',
    'DEV-1844/2 Build the brief',
    '  pointer: design section 4',
    '  open: none',
    'DEV-1844 Architect context',
    '  ruling q5282: "Approved as proposed"',
    '  open: none',
    'In flight:',
    '  cursor 1369 plan-task design step 3/7 design, awaiting q5277, runs 31110',
    '  unbound run 31111 review asking',
    '  unbound claim task:DEV-1844/2',
    `DEV-1844 review: lens correctness owed → ${PLATFORM_SLUG} review tier DEV-1844-work`,
    `Waiting: 2 board requests (${PLATFORM_SLUG} board read) · 0 questions · 3 filed issues (${PLATFORM_SLUG} workflow fix-defect --waiting) · 1 resume brief (${PLATFORM_SLUG} doc resumes)`,
    'Autonomy: plan review · implement, review, docs, canon auto · ship trunk',
  ])
})

test('renders one open question for its task holder', () => {
  const database = new Database(':memory:')
  database.exec(
    `CREATE TABLE context_item (
      record_id TEXT NOT NULL,
      holder_kind TEXT NOT NULL,
      holder_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      kind TEXT NOT NULL,
      body TEXT NOT NULL,
      source TEXT NOT NULL,
      question_number INTEGER,
      target TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE question (
      number INTEGER NOT NULL,
      workflow_task_record_id TEXT,
      question TEXT NOT NULL,
      answered_at TEXT,
      closed_at TEXT
    )`,
  )
  database
    .query(
      `INSERT INTO question
       (number,workflow_task_record_id,question,answered_at,closed_at)
       VALUES (5277,'task-record','Which shape should the brief use?',NULL,NULL),
              (5278,'task-record','Already answered.','2026-11-13',NULL),
              (5279,'task-record','Closed without an answer.',NULL,'2026-11-13')`,
    )
    .run()
  const holders = storedBriefHolders(
    [
      {
        key: 'DEV-1844/2',
        title: 'Build the brief',
        kind: 'task',
        recordId: 'task-record',
      },
    ],
    database,
  )
  const brief: ContextBrief = {
    session: '65fbe830',
    fullCommand: `${PLATFORM_SLUG} agent context show --task DEV-1844/2`,
    holders,
    runs: [],
    cursors: [],
    claims: [],
    waiting: {
      boardRequests: 0,
      questions: { worker: 1, user: 0, foreign: 0, unowned: 0 },
      filedIssues: 0,
      resumeBriefs: 0,
    },
    autonomy: 'unknown',
  }

  expect(renderContextBrief(brief)).toContain(
    'DEV-1844/2 Build the brief\n  open: Which shape should the brief use?',
  )
  expect(renderContextBrief(brief)).not.toContain('Already answered')
  expect(renderContextBrief(brief)).not.toContain('Closed without an answer')
  database.close()
})

test('renders each non-empty inbox group and reports inbox read failure', () => {
  const base: ContextBrief = {
    session: 'session-a',
    fullCommand: `${PLATFORM_SLUG} agent context show --session session-a`,
    holders: [],
    runs: [],
    cursors: [],
    claims: [],
    waiting: {
      boardRequests: 0,
      questions: { worker: 2, user: 1, foreign: 3, unowned: 1 },
      filedIssues: 0,
      resumeBriefs: 0,
    },
    autonomy: 'unknown',
  }
  expect(renderContextBrief(base)).toContain(
    `2 worker questions · 1 on you · 3 other sessions' · 1 unowned (${PLATFORM_SLUG} question inbox --all --active)`,
  )
  expect(renderContextBrief({ ...base, waiting: { ...base.waiting, questions: null } })).toContain(
    `could not read question inbox (${PLATFORM_SLUG} question inbox --all --active)`,
  )
})

test('contextBrief carries question groups into the waiting segment', async () => {
  const session = 'context-brief-question-session'
  db()
    .query(
      `INSERT INTO project (record_id,name,path,stack,settings)
       VALUES (?,?,'/different-project','bun',
               '{"tracker":{"protocol":"hub"},"docs":{"protocol":"orch-docs"},"gate":"bun run check"}')`,
    )
    .run(newRecordId(), PLATFORM_SLUG)
  new Database(process.env.BOTTEGA_HUB_DB!, { create: true }).close()
  const migration = Bun.spawnSync([...bottegaEntryArgv(PLATFORM_SLUG), 'machine', 'migrate'], {
    env: { ...process.env, NODE_ENV: 'production' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(migration.exitCode, migration.stderr.toString()).toBe(0)
  const run = addRun({ agent: 'codex', job: 'implement', status: 'asking', session })
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,'Which?')`,
    )
    .run(newRecordId(), run, new Date().toISOString())

  const nodeEnvironment = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  const brief = await contextBrief(session, '/unregistered', db()).finally(() => {
    if (nodeEnvironment === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnvironment
  })

  expect(renderContextBrief(brief)).toContain(
    `1 worker question (${PLATFORM_SLUG} question inbox --all --active)`,
  )
})

test('orders the session, each project-scoped working task, and its epic by task profile', () => {
  const task = (key: string, project: string, title: string, parentKey: string | null = null) => ({
    key,
    project,
    title,
    parent_key: parentKey,
    record_id: `${project}:${key}`,
  })
  const tasks = [
    task('DEV-1844/2', PLATFORM_SLUG, 'Build the brief', 'DEV-1844'),
    task('DEV-1844', PLATFORM_SLUG, 'Architect context'),
    task('APP-7', 'other', 'Other project task'),
    task('DEV-2000', PLATFORM_SLUG, 'Parentless childless task'),
    task('SHARED-1', PLATFORM_SLUG, 'Platform shared key'),
    task('SHARED-1', 'other', 'Other shared key'),
  ]

  expect(
    holderSequence(
      '65fbe830',
      [
        { key: 'DEV-1844/2', project: PLATFORM_SLUG },
        { key: 'APP-7', project: 'other' },
        { key: 'DEV-2000', project: PLATFORM_SLUG },
        { key: 'SHARED-1', project: PLATFORM_SLUG },
        { key: 'SHARED-1', project: 'other' },
      ],
      tasks,
    ),
  ).toEqual([
    { key: '65fbe830', title: '', kind: 'session' },
    {
      key: 'DEV-1844/2',
      title: 'Build the brief',
      kind: 'task',
      recordId: `${PLATFORM_SLUG}:DEV-1844/2`,
    },
    {
      key: 'DEV-1844',
      title: 'Architect context',
      kind: 'epic',
      recordId: `${PLATFORM_SLUG}:DEV-1844`,
    },
    { key: 'APP-7', title: 'Other project task', kind: 'task', recordId: 'other:APP-7' },
    {
      key: 'DEV-2000',
      title: 'Parentless childless task',
      kind: 'task',
      recordId: `${PLATFORM_SLUG}:DEV-2000`,
    },
    {
      key: 'SHARED-1',
      title: 'Platform shared key',
      kind: 'task',
      recordId: `${PLATFORM_SLUG}:SHARED-1`,
    },
    {
      key: 'SHARED-1',
      title: 'Other shared key',
      kind: 'task',
      recordId: 'other:SHARED-1',
    },
  ])
})

test('reads a working task brief from its record-id holder while retaining the task key', () => {
  const recordId = newRecordId()
  db()
    .query(
      `INSERT INTO context_item
       (record_id,holder_kind,holder_id,slug,kind,body,source,created_at,updated_at)
       VALUES (?,'task',?,'position','position','Continue.','test',?,?)`,
    )
    .run(newRecordId(), recordId, '2026-11-09T10:00:00Z', '2026-11-09T10:00:00Z')
  const references = holderSequence(
    'session-id',
    [{ key: 'STAR-1', project: 'starship' }],
    [{ key: 'STAR-1', project: 'starship', record_id: recordId, title: 'Stable holder' }],
  )
  expect(storedBriefHolders(references, db())).toEqual([
    {
      key: 'STAR-1',
      title: 'Stable holder',
      kind: 'task',
      items: [
        expect.objectContaining(
          item(`task:${recordId}`, 'position', 'position', 'Continue.', 'test'),
        ),
      ],
    },
  ])
})

test('renders an open keyless cursor item under its cursor header without an open line', () => {
  const database = new Database(':memory:')
  database.exec(
    `CREATE TABLE context_item (
      record_id TEXT NOT NULL, holder_kind TEXT NOT NULL, holder_id TEXT NOT NULL,
      slug TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL,
      question_number INTEGER, target TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE TABLE question (
      number INTEGER NOT NULL, workflow_task_record_id TEXT, question TEXT NOT NULL,
      answered_at TEXT, closed_at TEXT
    )`,
  )
  const recordId = newRecordId()
  database
    .query(
      `INSERT INTO context_item
       (record_id,holder_kind,holder_id,slug,kind,body,source,created_at,updated_at)
       VALUES (?,'cursor',?,'decision','position','Continue here.','q42',?,?)`,
    )
    .run(newRecordId(), recordId, '2026-11-14T10:00:00Z', '2026-11-14T10:00:00Z')
  const holders = storedBriefHolders(
    holderSequence(
      'session-id',
      [],
      [],
      [
        {
          record_id: recordId,
          number: 42,
          workflow_slug: 'explore',
          mode_slug: 'default',
        },
      ],
    ),
    database,
  )

  const rendered = renderContextBrief({
    session: 'session-id',
    fullCommand: `${PLATFORM_SLUG} agent context show --session session-id`,
    holders,
    runs: [],
    cursors: [],
    claims: [],
    waiting: {
      boardRequests: 0,
      questions: { worker: 0, user: 0, foreign: 0, unowned: 0 },
      filedIssues: 0,
      resumeBriefs: 0,
    },
    autonomy: 'unknown',
  })
  expect(rendered).toContain('Cursor 42 explore default\n  position: Continue here.')
  expect(rendered).not.toContain('Cursor 42 explore default\n  position: Continue here.\n  open:')
  database.close()
})

test('selects only the task on an open cursor and lets holder order add its epic', () => {
  const session = newRecordId()
  const working = workingKeysForBrief([
    { workflow_key: 'DEV-2293', project: PLATFORM_SLUG },
    { workflow_key: '', project: PLATFORM_SLUG },
  ])
  expect(working).toEqual([{ key: 'DEV-2293', project: PLATFORM_SLUG }])
  expect(
    holderSequence(session, working, [
      {
        key: 'DEV-2293',
        project: PLATFORM_SLUG,
        record_id: newRecordId(),
        title: 'Open task',
        parent_key: 'DEV-2200',
      },
      {
        key: 'DEV-2200',
        project: PLATFORM_SLUG,
        record_id: newRecordId(),
        title: 'Epic',
      },
    ]).map((holder) => holder.key),
  ).toEqual([session, 'DEV-2293', 'DEV-2200'])
})

test('assigns cursor-bound runs and claims while retaining only unbound work', () => {
  const cursor = {
    record_id: 'cursor-record',
    project: PLATFORM_SLUG,
    workflow_key: 'DEV-2293',
    args: JSON.stringify({ worktree: '/tmp/dev-2293', branch: 'DEV-2293-work' }),
  }
  const selected = selectBriefInFlight(
    [
      { number: 101, job: 'implement', status: 'running', cursor_record_id: cursor.record_id },
      { number: 102, job: 'review', status: 'asking', cursor_record_id: null },
    ],
    [cursor],
    [
      { project: PLATFORM_SLUG, subject: { kind: 'task', value: 'DEV-2293' } },
      { project: PLATFORM_SLUG, subject: { kind: 'path', value: '/tmp/dev-2293' } },
      { project: PLATFORM_SLUG, subject: { kind: 'resource', value: 'DEV-2293-work' } },
      { project: PLATFORM_SLUG, subject: { kind: 'task', value: 'DEV-9999' } },
    ],
  )

  expect(selected).toEqual({
    runs: [{ number: 102, job: 'review', status: 'asking' }],
    cursorRuns: [{ recordId: cursor.record_id, runs: [101] }],
    claims: [{ kind: 'task', value: 'DEV-9999' }],
  })
})
