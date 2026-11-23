import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import {
  installTaskReader,
  type TaskLookupRow,
  type TaskReadPort,
} from '../workflow/task-read-port.ts'
import { composeWorkflowWithCursor } from '../workflow/workflow-cursor.ts'
import { installHostedWorkflowTreeFixture } from '../workflow/workflow-store.fixture.ts'
import {
  type ContextBrief,
  contextBrief,
  contextBriefCursorHandles,
  holderSequence,
  renderContextBrief,
  selectBriefInFlight,
  storedBriefHolders,
  workingKeysForBrief,
} from './context-brief.ts'

const BRIEF_RECORD_TASK_CALL_LIMIT = 4

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
    runs: [{ number: 31111, job: 'review', status: 'asking', label: 'Check the brief' }],
    cursors: [
      {
        recordId: 'cursor-record',
        number: 1369,
        project: PLATFORM_SLUG,
        key: 'DEV-1844/2',
        workflow: 'plan-task',
        mode: 'design',
        step: 3,
        totalSteps: 7,
        stepSlug: 'design',
        branch: null,
        worktree: null,
        tip: null,
        pr: null,
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
    '  cursor 1369 DEV-1844/2 plan-task design step 3/7 design, awaiting q5277, runs 31110',
    '  unbound run 31111 review asking · Check the brief',
    '  unbound claim task:DEV-1844/2',
    `DEV-1844 review: lens correctness owed → ${PLATFORM_SLUG} review tier DEV-1844-work`,
    `Waiting: 2 board requests (${PLATFORM_SLUG} board read) · 0 questions · 3 filed issues (${PLATFORM_SLUG} workflow fix-defect --waiting) · 1 resume brief (${PLATFORM_SLUG} doc resumes)`,
    'Autonomy: plan review · implement, review, docs, canon auto · ship trunk',
  ])
})

test('renders a keyless cursor with its idle age and close command', () => {
  const brief: ContextBrief = {
    session: 'session-a',
    fullCommand: `${PLATFORM_SLUG} agent context show --session session-a`,
    holders: [],
    runs: [],
    cursors: [
      {
        recordId: 'explore-record',
        number: 845,
        project: PLATFORM_SLUG,
        key: null,
        workflow: 'explore',
        mode: 'default',
        step: 1,
        totalSteps: 4,
        stepSlug: 'orient',
        branch: null,
        worktree: null,
        tip: null,
        pr: null,
        questionNumber: null,
        runs: [],
        keylessIdle: 'idle 2h 10m',
        keylessIdleMs: 7_800_000,
      },
    ],
    claims: [],
    waiting: {
      boardRequests: 0,
      questions: { worker: 0, user: 0, foreign: 0, unowned: 0 },
      filedIssues: 0,
      resumeBriefs: 0,
    },
    autonomy: 'unknown',
  }

  expect(renderContextBrief(brief)).toContain(
    `cursor 845 explore · idle 2h 10m → ${PLATFORM_SLUG} workflow abandon --cursor 845 --project ${PLATFORM_SLUG}`,
  )
})

test('renders unresolved task project question reads as unavailable', () => {
  const brief: ContextBrief = {
    session: 'session',
    fullCommand: 'full',
    holders: [
      {
        key: 'DEV-1',
        title: 'Unresolved task',
        kind: 'task',
        items: [],
        openQuestionsUnavailable:
          'questions unread for unresolved project missing-project; register or refresh the project, then retry',
      },
    ],
    runs: [],
    cursors: [],
    claims: [],
    waiting: { boardRequests: 0, questions: null, filedIssues: 0, resumeBriefs: 0 },
    autonomy: 'manual',
  }

  expect(renderContextBrief(brief)).toContain(
    'open: questions unread for unresolved project missing-project; register or refresh the project, then retry',
  )
  expect(renderContextBrief(brief)).not.toContain('open: none')
})

test('keeps a fresh keyless cursor visible without an abandon remedy', () => {
  const brief: ContextBrief = {
    session: 'session-a',
    fullCommand: `${PLATFORM_SLUG} agent context show --session session-a`,
    holders: [],
    runs: [],
    cursors: [
      {
        recordId: 'explore-record',
        number: 845,
        project: PLATFORM_SLUG,
        key: null,
        workflow: 'explore',
        mode: 'default',
        step: 1,
        totalSteps: 4,
        stepSlug: 'orient',
        branch: null,
        worktree: null,
        tip: null,
        pr: null,
        questionNumber: null,
        runs: [],
        keylessIdle: 'idle 10m',
        keylessIdleMs: 600_000,
      },
    ],
    claims: [],
    waiting: {
      boardRequests: 0,
      questions: { worker: 0, user: 0, foreign: 0, unowned: 0 },
      filedIssues: 0,
      resumeBriefs: 0,
    },
    autonomy: 'unknown',
  }

  const line = renderContextBrief(brief)
    .split('\n')
    .find((entry) => entry.includes('cursor 845'))
  expect(line).toBe('  cursor 845 explore · idle 10m')
  expect(line).not.toContain('workflow abandon')
})

test('renders one open question for its task holder', async () => {
  const database = migratedTestDatabase()
  database.exec('PRAGMA foreign_keys=OFF')
  database
    .query(
      `INSERT INTO project(record_id,name,path,stack,settings)
       VALUES ('00000000-0000-4000-8000-000000000001','fixture','/fixture','bun','{}')`,
    )
    .run()
  database
    .query(
      `INSERT INTO question
       (record_id,number,workflow_cursor_record_id,workflow_task_record_id,asked_at,question,answered_at,closed_at)
       VALUES ('question-5277',5277,'cursor-record','task-record','2026-11-13','Which shape should the brief use?',NULL,NULL),
              ('question-5278',5278,'cursor-record','task-record','2026-11-13','Already answered.','2026-11-13',NULL),
              ('question-5279',5279,'cursor-record','task-record','2026-11-13','Closed without an answer.',NULL,'2026-11-13')`,
    )
    .run()
  const holders = await storedBriefHolders(
    [
      {
        key: 'DEV-1844/2',
        title: 'Build the brief',
        kind: 'task',
        recordId: 'task-record',
        project: 'fixture',
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
  db().query('UPDATE run SET label=? WHERE record_id=?').run('Read the brief', run)
  db()
    .query(
      `INSERT INTO question (number,record_id,run_record_id,asked_at,question)
       VALUES ((SELECT COALESCE(MAX(number),0)+1 FROM question),?,?,?,'Which?')`,
    )
    .run(newRecordId(), run, new Date().toISOString())

  const nodeEnvironment = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  const brief = await contextBrief(session, '/unregistered', db(), async () => []).finally(() => {
    if (nodeEnvironment === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnvironment
  })

  expect(renderContextBrief(brief)).toContain(
    `1 worker question (${PLATFORM_SLUG} question inbox --all --active)`,
  )
  expect(brief.runs).toEqual([
    expect.objectContaining({ job: 'implement', status: 'asking', label: 'Read the brief' }),
  ])
  expect(renderContextBrief(brief)).toContain('implement asking · Read the brief')
})

test('contextBrief uses the session cursor rows for holders and in flight', async () => {
  const session = 'context-brief-cursor-session'
  const foreignSession = 'context-brief-foreign-session'
  const project = 'context-brief-cursor-project'
  db()
    .query(
      `INSERT INTO project (record_id,name,path,stack,settings)
       VALUES (?,?,'/different-project','bun',
               '{"tracker":{"protocol":"hub"},"docs":{"protocol":"orch-docs"},"gate":"bun run check"}')`,
    )
    .run(newRecordId(), project)
  db()
    .query(
      `INSERT INTO project (record_id,name,path,stack,settings)
       VALUES (?,?,'/unregistered','bun',
               '{"tracker":{"protocol":"hub"},"docs":{"protocol":"orch-docs"},"gate":"bun run check"}')`,
    )
    .run(newRecordId(), PLATFORM_SLUG)
  installHostedWorkflowTreeFixture(project, newRecordId(), resolve(process.cwd(), '..'))
  new Database(process.env.BOTTEGA_HUB_DB!, { create: true }).close()
  const migration = Bun.spawnSync([...bottegaEntryArgv(PLATFORM_SLUG), 'machine', 'migrate'], {
    env: { ...process.env, NODE_ENV: 'production' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(migration.exitCode, migration.stderr.toString()).toBe(0)
  const own = await composeWorkflowWithCursor(
    'explore',
    project,
    'default',
    {},
    { session },
    undefined,
    {},
    {},
  )
  const foreign = await composeWorkflowWithCursor(
    'explore',
    project,
    'default',
    {},
    { session: foreignSession },
    undefined,
    {},
    {},
  )

  const nodeEnvironment = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  const brief = await contextBrief(session, '/unregistered', db(), async () => []).finally(() => {
    if (nodeEnvironment === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = nodeEnvironment
  })
  const rendered = renderContextBrief(brief)

  expect(brief.holders.map((holder) => holder.title)).toContain(
    `Cursor ${own.cursor!.id} explore default (${project})`,
  )
  expect(brief.holders.map((holder) => holder.title)).not.toContain(
    `Cursor ${foreign.cursor!.id} explore default (${project})`,
  )
  expect(rendered).toContain(`cursor ${own.cursor!.id} explore · idle 0m`)
  expect(rendered).not.toContain(`cursor ${foreign.cursor!.id} explore`)
  expect(rendered).not.toContain('workflow abandon')
})

test('contextBrief drives lookup and filtered queue reads within its task-call budget', async () => {
  const session = 'context-brief-task-read-guard'
  const project = 'context-brief-task-read-project'
  const calls: Array<{ operation: 'list' | 'lookup'; status?: string }> = []
  const tasks: TaskLookupRow[] = Array.from({ length: 600 }, (_, index) => ({
    key: `DEV-${index + 1}`,
    record_id: `task-${index + 1}`,
    project,
    title: 'ordinary task',
    parent_key: null,
    status: 'open',
    status_category: 'open',
    last_seen: null,
    opened_at: null,
    has_children: false,
  }))
  const port: TaskReadPort = {
    async list(filters = {}) {
      calls.push({ operation: 'list', status: filters.status })
      if (!filters.status) throw new Error('unfiltered project task scan on a hook path')
      return []
    },
    async lookup(selectedProject, keys) {
      calls.push({ operation: 'lookup' })
      return tasks.filter((task) => task.project === selectedProject && keys.includes(task.key))
    },
    show: async () => {
      throw new Error('not used')
    },
    duplicates: async () => [],
    documents: async () => [],
    document: async () => {
      throw new Error('not used')
    },
  }
  installTaskReader(port)
  db()
    .query(
      `INSERT INTO project (record_id,name,path,stack,settings)
       VALUES (?,?,'/context-brief-task-read','bun',
               '{"tracker":{"protocol":"hub"},"docs":{"protocol":"orch-docs"}}')`,
    )
    .run(newRecordId(), project)
  installHostedWorkflowTreeFixture(project, newRecordId(), resolve(process.cwd(), '..'))
  const opened = await composeWorkflowWithCursor(
    'explore',
    project,
    'default',
    {},
    { session },
    undefined,
    {},
    {},
  )
  db()
    .query('UPDATE workflow_cursor SET workflow_key=?,task_record_id=? WHERE number=?')
    .run('DEV-1', 'task-1', opened.cursor!.id)

  await contextBrief(session, '/context-brief-task-read')

  expect(calls).toHaveLength(BRIEF_RECORD_TASK_CALL_LIMIT)
  expect(calls.every((call) => call.operation !== 'list' || call.status !== undefined)).toBe(true)
  installTaskReader(undefined as never)
})

test('orders the session, each project-scoped working task, and its epic by task profile', () => {
  const task = (
    key: string,
    project: string,
    title: string,
    parentKey: string | null = null,
    hasChildren = false,
  ) => ({
    key,
    project,
    title,
    parent_key: parentKey,
    record_id: `${project}:${key}`,
    has_children: hasChildren,
  })
  const tasks = [
    task('DEV-1844/2', PLATFORM_SLUG, 'Build the brief', 'DEV-1844'),
    task('DEV-1844', PLATFORM_SLUG, 'Architect context', null, true),
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
      project: PLATFORM_SLUG,
    },
    {
      key: 'DEV-1844',
      title: 'Architect context',
      kind: 'epic',
      recordId: `${PLATFORM_SLUG}:DEV-1844`,
      project: PLATFORM_SLUG,
    },
    {
      key: 'APP-7',
      title: 'Other project task',
      kind: 'task',
      recordId: 'other:APP-7',
      project: 'other',
    },
    {
      key: 'DEV-2000',
      title: 'Parentless childless task',
      kind: 'task',
      recordId: `${PLATFORM_SLUG}:DEV-2000`,
      project: PLATFORM_SLUG,
    },
    {
      key: 'SHARED-1',
      title: 'Platform shared key',
      kind: 'task',
      recordId: `${PLATFORM_SLUG}:SHARED-1`,
      project: PLATFORM_SLUG,
    },
    {
      key: 'SHARED-1',
      title: 'Other shared key',
      kind: 'task',
      recordId: 'other:SHARED-1',
      project: 'other',
    },
  ])
})

test('reads a working task brief from its record-id holder while retaining the task key', async () => {
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
  expect(await storedBriefHolders(references, db())).toEqual([
    {
      key: 'STAR-1',
      title: 'Stable holder',
      kind: 'task',
      openQuestionsUnavailable:
        'questions unread for unresolved project starship; register or refresh the project, then retry',
      items: [
        expect.objectContaining(
          item(`task:${recordId}`, 'position', 'position', 'Continue.', 'test'),
        ),
      ],
    },
  ])
})

test('renders an open keyless cursor item under its cursor header without an open line', async () => {
  const database = migratedTestDatabase()
  const recordId = newRecordId()
  database
    .query(
      `INSERT INTO context_item
       (record_id,holder_kind,holder_id,slug,kind,body,source,created_at,updated_at)
       VALUES (?,'cursor',?,'decision','position','Continue here.','q42',?,?)`,
    )
    .run(newRecordId(), recordId, '2026-11-14T10:00:00Z', '2026-11-14T10:00:00Z')
  const holders = await storedBriefHolders(
    holderSequence(
      'session-id',
      [],
      [],
      [
        {
          record_id: recordId,
          id: 42,
          workflow_slug: 'explore',
          mode_slug: 'default',
          project: PLATFORM_SLUG,
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
  expect(rendered).toContain(
    `Cursor 42 explore default (${PLATFORM_SLUG})\n  position: Continue here.`,
  )
  expect(rendered).not.toContain(
    `Cursor 42 explore default (${PLATFORM_SLUG})\n  position: Continue here.\n  open:`,
  )
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
      {
        number: 101,
        job: 'implement',
        status: 'running',
        label: 'Build it',
        cursor_record_id: 'cursor-source',
      },
      { number: 102, job: 'review', status: 'asking', label: null, cursor_record_id: null },
    ],
    [cursor],
    [
      { project: PLATFORM_SLUG, subject: { kind: 'task', value: 'DEV-2293' } },
      { project: PLATFORM_SLUG, subject: { kind: 'path', value: '/tmp/dev-2293' } },
      { project: PLATFORM_SLUG, subject: { kind: 'resource', value: 'DEV-2293-work' } },
      { project: PLATFORM_SLUG, subject: { kind: 'task', value: 'DEV-9999' } },
    ],
    [
      { record_id: 'cursor-middle', handed_off_from_record_id: 'cursor-source' },
      { record_id: cursor.record_id, handed_off_from_record_id: 'cursor-middle' },
    ],
  )

  expect(selected).toEqual({
    runs: [{ number: 102, job: 'review', status: 'asking', label: null }],
    cursorRuns: [{ recordId: cursor.record_id, runs: [101] }],
    claims: [{ kind: 'task', value: 'DEV-9999' }],
  })
})

test('gathers normalized cursor handles and degrades absent tip and pull request to null', () => {
  expect(
    contextBriefCursorHandles(
      {
        workflow_key: ' DEV-2324 ',
        project: 'unregistered-project',
        args: JSON.stringify({
          branch: ' DEV-2324-work ',
          worktree: '/path/that/does/not/exist',
        }),
      },
      db(),
    ),
  ).toEqual({
    key: 'DEV-2324',
    branch: 'DEV-2324-work',
    worktree: '/path/that/does/not/exist',
    tip: null,
    pr: null,
  })
})

test('renders a run label when present and preserves the old line when absent', () => {
  const base: ContextBrief = {
    session: 'session-a',
    fullCommand: 'full',
    holders: [],
    cursors: [],
    claims: [],
    runs: [
      { number: 1, job: 'implement', status: 'running', label: 'Prompt head fallback' },
      { number: 2, job: 'review', status: 'asking', label: null },
    ],
    waiting: {
      boardRequests: 0,
      questions: { worker: 0, user: 0, foreign: 0, unowned: 0 },
      filedIssues: 0,
      resumeBriefs: 0,
    },
    autonomy: 'unknown',
  }
  expect(renderContextBrief(base)).toContain(
    'unbound run 1 implement running · Prompt head fallback',
  )
  expect(renderContextBrief(base)).toContain('unbound run 2 review asking\n')
})
