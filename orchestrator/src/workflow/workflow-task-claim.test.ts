import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolvedRecordOrigin } from '../../../shared/record-api-url.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import {
  answerRunFlags,
  answerRunFromArgv,
  answerRunHelpers,
  newQuestionSql,
} from '../../test/fixtures/run-answer.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { ARGV_PROMPT_BYTES } from '../agent/agents.ts'
import { boardClaimList } from '../board/board-operations.ts'
import { db } from '../database/db.ts'
import { rememberActiveRecordSpace } from '../project-space.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import { continueRun } from '../run/run-control.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { installWorkflowStoreFixture } from './workflow-store.fixture.ts'
import {
  decideTaskCursorClaim,
  followTaskCursorClaim,
  renewTaskClaim,
  type TaskCursorClaimPorts,
} from './workflow-task-claim.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

const input = {
  project: 'claim-cursor-project',
  taskKey: 'DEV-2387',
  session: 'session-a',
} as const

async function prepareClaimRenewalFixture(workflowSlug: string): Promise<string> {
  db()
    .query('UPDATE project SET stack=?,settings=? WHERE name=?')
    .run(
      'bun',
      JSON.stringify({
        docs: { protocol: 'orch-docs' },
        gate: 'bun run check',
        trunk: 'main',
        tracker: { protocol: 'hub' },
      }),
      input.project,
    )
  seedWorkflows(db())
  installWorkflowStoreFixture(db())
  const draft = setWorkflowLocal(
    workflowSlug,
    {
      title: 'Claim renewal fixture',
      description: 'Keeps an open keyed cursor for run-event renewal.',
      arguments: [{ name: 'key', required: true, description: 'Task key.' }],
      modes: [{ slug: 'default', title: 'Default', default: true, steps: ['complete'] }],
    },
    'claim renewal fixture',
    'test',
    db(),
  )
  promoteWorkflowLocal(workflowSlug, draft.n, 'publish', 'test', db())
  await composeWorkflowWithCursor(
    workflowSlug,
    input.project,
    'default',
    { key: input.taskKey },
    { session: input.session, taskRecordId: 'task-DEV-2387' },
    db(),
    {},
    {},
  )
  await followTaskCursorClaim({ ...input, verb: 'compose' })
  const before = new Date(Date.now() + 1_000).toISOString()
  db()
    .query("UPDATE board_claim SET lapses_at=? WHERE subject_kind='task' AND subject_value=?")
    .run(before, input.taskKey)
  return before
}

function addAskingKeyedRun(): string {
  const root = addRun({
    agent: 'codex',
    job: 'summarize',
    status: 'asking',
    session: input.session,
  })
  db()
    .query('UPDATE run SET vendor_session=?,cwd=?,launch_key=? WHERE record_id=?')
    .run('vendor-session', dir, input.taskKey, root)
  db().query(newQuestionSql()).run(root, new Date().toISOString(), 'which shape?')
  return root
}

beforeEach(() => {
  db().query('DELETE FROM board_claim').run()
  db()
    .query(
      `INSERT OR IGNORE INTO project(record_id,name,path,settings)
       VALUES (lower(hex(randomblob(4))) || '-0000-7000-8000-' || lower(hex(randomblob(6))),?,?, '{}')`,
    )
    .run('claim-cursor-project', process.cwd())
})

afterEach(() => installRecordApiClient(null))

describe('task cursor claim decision', () => {
  test('an owner verb takes or renews the owner claim', () => {
    expect(decideTaskCursorClaim({ ...input, verb: 'advance' })).toEqual({
      action: 'take',
      project: 'claim-cursor-project',
      key: 'DEV-2387',
      session: 'session-a',
    })
  })

  test('closing verbs release the claim, including without a harness session', () => {
    for (const verb of ['finish', 'abandon'] as const)
      expect(decideTaskCursorClaim({ ...input, session: null, verb })).toEqual({
        action: 'release',
        project: 'claim-cursor-project',
        key: 'DEV-2387',
      })
  })

  test('keyless cursors do not touch task claims', () => {
    expect(decideTaskCursorClaim({ ...input, taskKey: null, verb: 'compose' })).toEqual({
      action: 'none',
    })
  })
})

test('a rejecting take propagates', async () => {
  const ports: TaskCursorClaimPorts = {
    take: async () => {
      throw new Error('claim refused')
    },
    release: async () => ({ released: 0 }),
  }
  await expect(followTaskCursorClaim({ ...input, verb: 'compose' }, ports)).rejects.toThrow(
    'claim refused',
  )
})

test('the local adapter moves a compose claim and finish leaves none live', async () => {
  await followTaskCursorClaim({ ...input, verb: 'compose' })
  await followTaskCursorClaim({ ...input, session: 'session-b', verb: 'compose' })

  const moved = await boardClaimList('claim-cursor-project', true, { env: {} })
  expect(moved.claims).toHaveLength(2)
  expect(moved.claims[0]).toMatchObject({
    holder: 'session-a',
    closeReason: 'taken-over',
  })
  expect(moved.claims[1]).toMatchObject({ holder: 'session-b', live: true })

  await followTaskCursorClaim({ ...input, session: 'session-b', verb: 'finish' })
  expect((await boardClaimList('claim-cursor-project', false, { env: {} })).claims).toEqual([])
})

test('the local adapter releases a claim on session-less abandon', async () => {
  await followTaskCursorClaim({ ...input, verb: 'compose' })
  await followTaskCursorClaim({ ...input, session: null, verb: 'abandon' })

  expect((await boardClaimList('claim-cursor-project', false, { env: {} })).claims).toEqual([])
})

test('continuing a keyed run moves its owning cursor claim lapse forward', async () => {
  const before = await prepareClaimRenewalFixture('continue-claim-renewal-fixture')
  const root = addRun({
    agent: 'codex',
    job: 'summarize',
    status: 'ok',
    session: input.session,
  })
  db()
    .query(
      'UPDATE run SET vendor_session=?,cwd=?,worktree=NULL,base_commit=NULL,launch_key=? WHERE record_id=?',
    )
    .run('vendor-session', dir, input.taskKey, root)

  const previousSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = input.session
  try {
    await continueRun(root, 'continue renewal', () => ARGV_PROMPT_BYTES, undefined, {
      renewTaskClaim,
    })
  } finally {
    if (previousSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previousSession
  }

  const after = db()
    .query<{ lapses_at: string }, [string]>(
      "SELECT lapses_at FROM board_claim WHERE subject_kind='task' AND subject_value=? AND closed_at IS NULL",
    )
    .get(input.taskKey)!.lapses_at
  expect(after > before).toBeTrue()
})

test('answering a keyed run moves its owning cursor claim lapse forward', async () => {
  const before = await prepareClaimRenewalFixture('answer-claim-renewal-fixture')
  const root = addAskingKeyedRun()
  const previousSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = input.session
  try {
    await answerRunFromArgv(
      root,
      { argv: ['use the existing shape'], recordOnly: true, flags: answerRunFlags },
      { ...answerRunHelpers, renewTaskClaim },
    )
  } finally {
    if (previousSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previousSession
  }

  const after = db()
    .query<{ lapses_at: string }, [string]>(
      "SELECT lapses_at FROM board_claim WHERE subject_kind='task' AND subject_value=? AND closed_at IS NULL",
    )
    .get(input.taskKey)!.lapses_at
  expect(after > before).toBeTrue()
})

test('a failed answer renewal warns without failing the answer', async () => {
  await prepareClaimRenewalFixture('answer-failed-renewal-fixture')
  const root = addAskingKeyedRun()
  const previousSession = process.env.CLAUDE_CODE_SESSION_ID
  process.env.CLAUDE_CODE_SESSION_ID = input.session
  const warning = console.error
  const warnings: unknown[][] = []
  console.error = (...args: unknown[]) => warnings.push(args)
  try {
    const answered = await answerRunFromArgv(
      root,
      { argv: ['use the existing shape'], recordOnly: true, flags: answerRunFlags },
      {
        ...answerRunHelpers,
        renewTaskClaim: async () => {
          throw new Error('claim store unavailable')
        },
      },
    )
    expect(answered.outcome).toBe('recorded')
    expect(
      warnings.some((args) => args.some((arg) => String(arg).includes(input.taskKey))),
    ).toBeTrue()
  } finally {
    console.error = warning
    if (previousSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previousSession
  }
})

test('renewing finds an open cursor that exists only in the hosted read store', async () => {
  const database = db()
  const space = '01990000-0000-7000-8000-000000000002'
  database.query('UPDATE project SET stack=?,settings=? WHERE name=?').run(
    'bun',
    JSON.stringify({
      docs: { protocol: 'orch-docs' },
      gate: 'bun run check',
      space,
      trunk: 'main',
      tracker: { protocol: 'hub' },
    }),
    input.project,
  )
  seedWorkflows(database)
  installWorkflowStoreFixture(database)
  const draft = setWorkflowLocal(
    'hosted-claim-renewal-fixture',
    {
      title: 'Hosted claim renewal fixture',
      description: 'Keeps an open keyed cursor only in the hosted read store.',
      arguments: [{ name: 'key', required: true, description: 'Task key.' }],
      modes: [{ slug: 'default', title: 'Default', default: true, steps: ['complete'] }],
    },
    'hosted claim renewal fixture',
    'test',
    database,
  )
  promoteWorkflowLocal('hosted-claim-renewal-fixture', draft.n, 'publish', 'test', database)
  for (const table of ['workflow', 'workflow_version', 'step_catalogue', 'step_catalogue_version'])
    database.query(`UPDATE ${table} SET space_id=?`).run(space)
  rememberActiveRecordSpace(database, space)
  rememberProjectSpace(database, input.project, space)
  database
    .query('INSERT INTO record_install_binding (id,bound_at,record_origin) VALUES (1,?,?)')
    .run('2026-11-17T00:00:00.000Z', resolvedRecordOrigin())
  const projectId = database
    .query<{ record_id: string }, [string]>('SELECT record_id FROM project WHERE name=?')
    .get(input.project)!.record_id
  const client = createMemoryRecordApiClient({
    taskFlowStages: [],
    taskFlowProjectNames: { [projectId]: input.project },
    taskFlowProjectSpaces: { [projectId]: space },
  })
  installRecordApiClient(client)

  await composeWorkflowWithCursor(
    'hosted-claim-renewal-fixture',
    input.project,
    'default',
    { key: input.taskKey },
    {
      session: input.session,
      taskRecordId: '01990000-0000-7000-8000-000000000003',
      taskFlowClient: client,
    },
    database,
    {},
    {},
  )
  expect(
    database.query('SELECT 1 FROM workflow_cursor WHERE workflow_key=?').get(input.taskKey),
  ).toBeNull()
  await followTaskCursorClaim({ ...input, verb: 'compose' })
  const before = new Date(Date.now() + 1_000).toISOString()
  database
    .query("UPDATE board_claim SET lapses_at=? WHERE subject_kind='task' AND subject_value=?")
    .run(before, input.taskKey)

  await renewTaskClaim(input.taskKey, input.session)

  const after = database
    .query<{ lapses_at: string }, [string]>(
      "SELECT lapses_at FROM board_claim WHERE subject_kind='task' AND subject_value=? AND closed_at IS NULL",
    )
    .get(input.taskKey)!.lapses_at
  expect(after > before).toBeTrue()
})
