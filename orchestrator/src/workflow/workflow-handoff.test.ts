import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import { awaitWorkflowRuling, composeWorkflowWithCursor } from './workflow-cursor.ts'
import { database, selectAndNextWorkflowStep, testPorts } from './workflow-cursor-test.fixture.ts'
import { handoffWorkflow } from './workflow-handoff.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

function install(d: ReturnType<typeof database>, slug: string, steps: string[]) {
  const draft = setWorkflowLocal(
    slug,
    {
      title: slug,
      description: 'handoff fixture',
      arguments: [
        { name: 'key', required: true, description: 'Task key.' },
        { name: 'branch', required: true, description: 'Branch.' },
        { name: 'worktree', required: true, description: 'Worktree.' },
      ],
      modes: [{ slug: 'default', title: 'Default', default: true, steps }],
    },
    'handoff fixture',
    'test',
    d,
  )
  promoteWorkflowLocal(slug, draft.n, 'handoff fixture', 'test', d)
}

const refusalArgs = {
  key: 'DEV-HANDOFF-REFUSAL',
  branch: 'DEV-HANDOFF-REFUSAL-work',
  worktree: '/tmp/work',
}
const refusalContext = {
  session: 'handoff-refusal-session',
  taskRecordId: 'task-DEV-HANDOFF-REFUSAL',
  taskStatusCategory: 'active',
}

async function refusalFixture(target = 'handoff-target') {
  const d = database()
  install(d, 'handoff-source', ['lens', 'score'])
  install(d, target, ['score'])
  const opened = await composeWorkflowWithCursor(
    'handoff-source',
    'fixture',
    'default',
    refusalArgs,
    refusalContext,
    d,
    {},
    {},
  )
  const cursor = opened.cursor!.id
  const row = (await taskFlowReadStore(d).stageByHandle('fixture', cursor))!
  return { d, cursor, row }
}

function cursorSnapshot(d: ReturnType<typeof database>, recordId: string) {
  return d
    .query<{ state: string; ordinal: number; revision: number; closed: string }, [string]>(
      'SELECT state,ordinal,revision,closed FROM workflow_cursor WHERE record_id=?',
    )
    .get(recordId)!
}

async function expectRefusalUnchanged(
  fixture: Awaited<ReturnType<typeof refusalFixture>>,
  call: () => Promise<unknown>,
  fix: string,
) {
  const before = cursorSnapshot(fixture.d, fixture.row.record_id)
  await expect(call()).rejects.toThrow(fix)
  expect(cursorSnapshot(fixture.d, fixture.row.record_id)).toEqual(before)
  expect(
    fixture.d
      .query<{ count: number }, [string]>(
        'SELECT count(*) AS count FROM workflow_cursor WHERE handed_off_from_record_id=?',
      )
      .get(fixture.row.record_id),
  ).toEqual({ count: 0 })
}

function handoffCall(
  fixture: Awaited<ReturnType<typeof refusalFixture>>,
  overrides: Partial<Parameters<typeof handoffWorkflow>[0]> = {},
) {
  return () =>
    handoffWorkflow({
      row: fixture.row,
      workflow: 'handoff-target',
      mode: 'default',
      args: refusalArgs,
      reason: 'ready',
      context: refusalContext,
      live: {},
      database: fixture.d,
      ...overrides,
    })
}

test('handoff closes the old stage, opens and links the successor, moves context, and renews the same claim', async () => {
  const d = database()
  install(d, 'handoff-source', ['lens', 'score', 'complete'])
  install(d, 'handoff-target', ['score'])
  const args = { key: 'DEV-HANDOFF', branch: 'DEV-HANDOFF-work', worktree: '/tmp/work' }
  const context = {
    session: 'handoff-session',
    taskRecordId: 'task-DEV-HANDOFF',
    taskStatusCategory: 'active',
  }
  const opened = await composeWorkflowWithCursor(
    'handoff-source',
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    {},
  )
  const oldNumber = opened.cursor!.id
  d.query("UPDATE workflow_cursor SET enforcement='note-only' WHERE number=?").run(oldNumber)
  await selectAndNextWorkflowStep(
    'handoff-source',
    'fixture',
    'default',
    args,
    'first done',
    context,
    d,
    {},
    testPorts,
  )
  const old = (await taskFlowReadStore(d).stageByHandle('fixture', oldNumber))!
  d.query(`INSERT INTO context_item
    (record_id,holder_kind,holder_id,slug,kind,body,source,created_at,updated_at)
    VALUES (?,'cursor',?,'decision','fact','carry me','test',?,?)`).run(
    newRecordId(),
    old.record_id,
    old.created_at,
    old.created_at,
  )
  const claim = d
    .query<{ record_id: string }, [string]>(
      'SELECT record_id FROM board_claim WHERE subject_value=? AND closed_at IS NULL',
    )
    .get('DEV-HANDOFF')
  const takes: string[] = []
  const result = await handoffWorkflow({
    row: old,
    workflow: 'handoff-target',
    mode: 'default',
    args,
    reason: 'ready to ship',
    context,
    live: {},
    database: d,
    taskClaimPorts: {
      take: async ({ project, key, session }) => {
        takes.push(key)
        return {
          action: 'renewed',
          recordId: claim?.record_id ?? 'claim',
          project,
          subject: { kind: 'task', value: key },
          holder: session,
          note: null,
          runId: null,
          run_record_id: null,
          takenAt: old.created_at,
          renewedAt: old.updated_at,
          lapsesAt: old.updated_at,
          live: true,
          closedAt: null,
          closeReason: null,
          previousClaimRecordIds: [],
          supersededByClaimRecordId: null,
        }
      },
      release: async () => ({ released: 0 }),
    },
  })
  const oldAfter = (await taskFlowReadStore(d).stageByHandle('fixture', oldNumber))!
  const next = (await taskFlowReadStore(d).stageByHandle('fixture', result.cursor))!
  expect(oldAfter.state).toBe('done')
  expect(
    (JSON.parse(oldAfter.closed) as Array<{ note: string }>).map((entry) => entry.note),
  ).toEqual([
    'first done',
    `handed off to handoff-target (cursor ${result.cursor}): ready to ship`,
    'not run: handed off',
  ])
  expect(next).toMatchObject({
    state: 'running',
    ordinal: 0,
    handed_off_from_record_id: old.record_id,
    session_id: context.session,
  })
  expect(d.query('SELECT holder_id FROM context_item WHERE slug=?').get('decision')).toEqual({
    holder_id: next.record_id,
  })
  expect(takes).toEqual(['DEV-HANDOFF'])
  expect(claim?.record_id).toBeTruthy()
})

test('handoff refuses an unknown workflow without changing the old cursor or opening a successor', async () => {
  const fixture = await refusalFixture()
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture, { workflow: 'missing-handoff-target' }),
    'workflow "missing-handoff-target" has no production version; promote one',
  )
})

test('handoff refuses a missing required argument without changing the old cursor or opening a successor', async () => {
  const fixture = await refusalFixture()
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture, { args: { key: refusalArgs.key } }),
    'pass each with --arg k=v',
  )
})

test('handoff refuses ship-task with an empty branch without changing the old cursor or opening a successor', async () => {
  const fixture = await refusalFixture('ship-task')
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture, { workflow: 'ship-task', commitCount: () => 0 }),
    `build the change first with \`${PLATFORM_SLUG} run start implement --key <key>\``,
  )
})

test('handoff refuses a different key without changing the old cursor or opening a successor', async () => {
  const fixture = await refusalFixture()
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture, { args: { ...refusalArgs, key: 'DEV-OTHER' } }),
    `pass --arg key=${refusalArgs.key}`,
  )
})

test('handoff refuses a cursor awaiting a ruling without changing it or opening a successor', async () => {
  const fixture = await refusalFixture()
  fixture.d
    .query(
      "UPDATE workflow_cursor SET state='awaiting-ruling',question='Proceed?' WHERE record_id=?",
    )
    .run(fixture.row.record_id)
  fixture.row = (await taskFlowReadStore(fixture.d).stageByHandle('fixture', fixture.cursor))!
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture),
    'answer its question, then retry the handoff',
  )
})

test('handoff refuses a cursor with an open workflow question without changing it or opening a successor', async () => {
  const fixture = await refusalFixture()
  await awaitWorkflowRuling(
    'handoff-source',
    'fixture',
    'default',
    refusalArgs,
    'Which way?',
    refusalContext,
    fixture.d,
    () => {},
  )
  fixture.row = (await taskFlowReadStore(fixture.d).stageByHandle('fixture', fixture.cursor))!
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture),
    'answer its question, then retry the handoff',
  )
})

test("handoff refuses another session's cursor without changing it or opening a successor", async () => {
  const fixture = await refusalFixture()
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture, {
      context: { ...refusalContext, session: 'another-session' },
    }),
    `hand off it from that session`,
  )
})

test('handoff refuses a missing reason without changing the old cursor or opening a successor', async () => {
  const fixture = await refusalFixture()
  await expectRefusalUnchanged(
    fixture,
    handoffCall(fixture, { reason: '  ' }),
    'pass --reason "<why>"',
  )
})
