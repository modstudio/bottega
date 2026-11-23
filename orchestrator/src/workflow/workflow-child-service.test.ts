import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  createMemoryRecordApiClient,
  installRecordApiClient,
} from '../../test/fixtures/record-api.ts'
import { BOARD_HOSTED_ADOPTED_KEY } from '../board/board-mode.ts'
import { boardClaimTake, boardQueuedClaimClose } from '../board/board-operations.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import type { HostedBoardClaim } from '../record/record-board-contract.ts'
import { sessionStopSummary } from '../session/stop-summary.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import { installTaskReader, type TaskReadPort, type TaskReadRow } from './task-read-port.ts'
import {
  inheritClosedSteps,
  queueWorkflowChild,
  startWorkflowChild,
} from './workflow-child-service.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { seedCurrentWorkflowTreeFixture } from './workflow-store.fixture.ts'
import { composeWorkflow } from './workflows.ts'

const database = testDatabaseFixture((d) => {
  seedCurrentWorkflowTreeFixture(d, ['plan-task'], 'epic child service fixture')
})

let previousTaskReader: TaskReadPort | undefined
let previousRecordApiUrl: string | undefined
beforeEach(() => {
  previousTaskReader = installTaskReader(undefined)
  previousRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
})
afterEach(() => {
  installTaskReader(previousTaskReader)
  installRecordApiClient(null)
  if (previousRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = previousRecordApiUrl
})

const row = (key: string, parentKey: string | null): TaskReadRow => ({
  key,
  record_id: `task-${key}`,
  project: 'fixture',
  title: key,
  parent_key: parentKey,
  source: 'fixture',
  status: 'Open',
  status_category: 'open',
  last_seen: null,
  body: null,
  opened_at: '2026-11-19T00:00:00.000Z',
})

function installTasks(tasks: TaskReadRow[]) {
  const byKey = new Map(tasks.map((task) => [task.key, task]))
  const port: TaskReadPort = {
    lookup: async (_project, keys) => {
      const found = new Map<string, TaskReadRow & { has_children: boolean }>()
      for (const key of keys) {
        let task = byKey.get(key)
        while (task && !found.has(task.key)) {
          found.set(task.key, {
            ...task,
            has_children: tasks.some((candidate) => candidate.parent_key === task!.key),
          })
          task = task.parent_key ? byKey.get(task.parent_key) : undefined
        }
      }
      return [...found.values()]
    },
    list: async ({ project } = {}) => tasks.filter((task) => !project || task.project === project),
    show: async (key) => ({ task: byKey.get(key)! }),
    duplicates: async () => [],
    documents: async () => [],
    document: async () => ({
      id: 'none',
      label: 'none',
      task_record_id: 'task-none',
      title: 'none',
      body: '',
      version: '1',
      updated_at: '2026-11-19T00:00:00.000Z',
    }),
  }
  installTaskReader(port)
}

const claimPorts = (d: Database) => ({
  take: ({ project, key, session }: { project: string; key: string; session: string }) =>
    boardClaimTake(
      { project, subject: `task:${key}` },
      { database: d, cwd: '/fixture', taskCursorAuthority: { mode: 'take' as const, session } },
    ),
  release: async () => ({ released: 0 }),
})

async function openEpicAtStart(
  d: Database,
  tasks: TaskReadRow[],
  session = 'epic-owner',
  epic = 'DEV-1',
) {
  installTasks(tasks)
  const composition = composeWorkflow('plan-task', 'fixture', 'feature', { key: epic }, d)
  const opened = await composeWorkflowWithCursor(
    'plan-task',
    'fixture',
    'feature',
    { key: epic },
    { session, workflowKey: epic, taskRecordId: `task-${epic}`, taskStatusCategory: 'open' },
    d,
    {},
    {},
    undefined,
    claimPorts(d),
  )
  const startOrdinal = composition.steps.findIndex(({ slug }) => slug === 'start')
  const closed = composition.steps.slice(0, startOrdinal).map((step, index) => ({
    n: index + 1,
    slug: step.slug,
    note: `epic ${step.slug} complete`,
    at: '2026-11-19T00:00:00.000Z',
  }))
  d.query('UPDATE workflow_cursor SET ordinal=?,step_slug=?,closed=? WHERE number=?').run(
    startOrdinal,
    'start',
    JSON.stringify(closed),
    opened.cursor!.id,
  )
  return { cursor: opened.cursor!.id, startOrdinal, closed }
}

function hostedClaim(
  subject: { kind: 'task' | 'queued-task'; value: string },
  holderSession: string | null,
): HostedBoardClaim {
  return {
    id: newRecordId(),
    project: 'fixture',
    subject,
    holder: 'user-u',
    holderSession,
    note: null,
    runId: null,
    takenAt: '2026-11-23T12:00:00.000Z',
    renewedAt: '2026-11-23T12:00:00.000Z',
    lapsesAt: '2099-11-23T12:00:00.000Z',
    live: true,
    closedAt: null,
    closeReason: null,
    previousClaimIds: [],
    supersededByClaimId: null,
  }
}

function useHostedClaims(d: Database, claims: ReturnType<typeof hostedClaim>[]) {
  d.query('DELETE FROM board_claim').run()
  d.query(
    "UPDATE project SET settings=json_set(settings,'$.space','space-fixture') WHERE name='fixture'",
  ).run()
  d.query('INSERT INTO schema_meta(key,value) VALUES (?,?)').run(BOARD_HOSTED_ADOPTED_KEY, '1')
  process.env.BOTTEGA_RECORD_API_URL = 'https://record.test'
  let listCalls = 0
  installRecordApiClient({
    ...createMemoryRecordApiClient(),
    whoami: async () => ({
      user: { id: 'user-u', email: 'u@example.test' },
      activeSpaceId: 'space-fixture',
      personalSpaceId: 'space-fixture',
      memberships: [
        {
          space_id: 'space-fixture',
          name: 'Fixture',
          slug: 'space-fixture',
          role: 'member' as const,
          permission: 'write' as const,
        },
      ],
    }),
    listBoardClaims: async () => {
      listCalls++
      return { claims }
    },
    takeBoardClaim: async (input) => {
      const [kind, value] = input.subject.split(':', 2)
      if (kind !== 'queued-task' || !value) throw new Error('unexpected hosted claim subject')
      const claim = hostedClaim({ kind, value }, input.holderSession ?? null)
      claims.push(claim)
      return { ...claim, action: 'taken' as const }
    },
    releaseBoardClaim: async (id, _destination, input) => {
      const claim = claims.find((candidate) => candidate.id === id)
      if (!claim || claim.holderSession !== input.holderSession)
        throw new Error('hosted queued claim release did not match its holder session')
      claim.live = false
      claim.closedAt = '2026-11-23T12:01:00.000Z'
      claim.closeReason = 'released'
      return claim
    },
  })
  return { listCalls: () => listCalls }
}

test('start-child opens at start with inherited closures and parent flow', async () => {
  const d = database()
  const tasks = [row('DEV-1', null), row('DEV-2', 'DEV-1')]
  const epic = await openEpicAtStart(d, tasks)
  const started = await startWorkflowChild(
    { project: 'fixture', cursor: epic.cursor, task: 'DEV-2', callerSession: 'epic-owner' },
    d,
  )
  const child = await taskFlowReadStore(d).stageByHandle('fixture', started.cursor.id)
  expect(child).toMatchObject({
    step_slug: 'start',
    ordinal: epic.startOrdinal,
    session_id: 'epic-owner',
  })
  const inherited = JSON.parse(child!.closed) as Array<{ note: string }>
  expect(inherited).toHaveLength(epic.startOrdinal)
  expect(
    inherited.every(({ note }) => note.includes(`inherited from cursor ${epic.cursor} step`)),
  ).toBeTrue()
  const flows = d
    .query<{ task_record_id: string; record_id: string; parent_flow_record_id: string | null }, []>(
      'SELECT task_record_id,record_id,parent_flow_record_id FROM task_flow ORDER BY task_record_id',
    )
    .all()
  expect(
    flows.find(({ task_record_id }) => task_record_id === 'task-DEV-2')?.parent_flow_record_id,
  ).toBe(flows.find(({ task_record_id }) => task_record_id === 'task-DEV-1')?.record_id)
})

test('hosted child eligibility reads the record claim and compares its session identity', async () => {
  const d = database()
  const tasks = [row('DEV-1', null), row('DEV-2', 'DEV-1')]
  await openEpicAtStart(d, tasks)
  const queued = hostedClaim({ kind: 'queued-task', value: 'DEV-2' }, 'session-s')
  const reads = useHostedClaims(d, [
    hostedClaim({ kind: 'task', value: 'DEV-1' }, 'session-s'),
    queued,
  ])

  for (const callerSession of ['other-session', 'user-u']) {
    await expect(
      queueWorkflowChild(
        {
          project: 'fixture',
          child: 'DEV-2',
          session: callerSession,
          callerSession,
          off: true,
        },
        d,
      ),
    ).rejects.toThrow(
      `calling session ${callerSession} does not hold epic DEV-1 or a queued child under it`,
    )
  }
  const released = await queueWorkflowChild(
    {
      project: 'fixture',
      child: 'DEV-2',
      session: 'session-s',
      callerSession: 'session-s',
      off: true,
    },
    d,
  )
  expect(released).toMatchObject({ child: 'DEV-2' })
  expect(queued.live).toBeFalse()
  expect(reads.listCalls()).toBe(4)
})

test('a hosted queued descendant claim authorizes its holder session', async () => {
  const d = database()
  const tasks = [row('DEV-1', null), row('DEV-2', 'DEV-1')]
  await openEpicAtStart(d, tasks)
  const queued = hostedClaim({ kind: 'queued-task', value: 'DEV-2' }, 'session-s')
  useHostedClaims(d, [queued])
  const released = await queueWorkflowChild(
    {
      project: 'fixture',
      child: 'DEV-2',
      session: 'session-s',
      callerSession: 'session-s',
      off: true,
    },
    d,
  )
  expect(released).toMatchObject({ child: 'DEV-2' })
  expect(queued.live).toBeFalse()
})

test('queue reads the hosted claim snapshot once before taking the child claim', async () => {
  const d = database()
  const tasks = [row('DEV-1', null), row('DEV-2', 'DEV-1')]
  await openEpicAtStart(d, tasks)
  const claims = [hostedClaim({ kind: 'task', value: 'DEV-1' }, 'session-s')]
  const reads = useHostedClaims(d, claims)
  await expect(
    queueWorkflowChild(
      {
        project: 'fixture',
        child: 'DEV-2',
        session: 'session-s',
        callerSession: 'session-s',
        off: false,
      },
      d,
    ),
  ).resolves.toMatchObject({ child: 'DEV-2' })
  expect(reads.listCalls()).toBe(1)
  expect(claims).toContainEqual(
    expect.objectContaining({
      subject: { kind: 'queued-task', value: 'DEV-2' },
      holderSession: 'session-s',
    }),
  )
})

test('inherited start maps parent closures to child ordinals by slug', () => {
  const at = '2026-11-19T00:00:00.000Z'
  const inherited = inheritClosedSteps(
    7,
    [
      { n: 1, slug: 'design', note: 'designed', at },
      { n: 2, slug: 'design-signoff', note: 'approved', at },
      { n: 3, slug: 'write', note: 'written', at },
    ],
    [{ slug: 'design' }, { slug: 'write' }, { slug: 'start' }],
  )
  expect(inherited).toMatchObject({ startOrdinal: 2 })
  expect(inherited.closed.map(({ n, slug }) => ({ n, slug }))).toEqual([
    { n: 1, slug: 'design' },
    { n: 2, slug: 'write' },
  ])
  expect(inherited.closed[1]?.note).toContain('cursor 7 step write: written')
})

test('grandchild inherits from the nearest ancestor flow when its container has none', async () => {
  const d = database()
  const tasks = [row('DEV-1', null), row('DEV-2', 'DEV-1'), row('DEV-3', 'DEV-2')]
  const epic = await openEpicAtStart(d, tasks)
  const started = await startWorkflowChild(
    { project: 'fixture', cursor: epic.cursor, task: 'DEV-3', callerSession: 'epic-owner' },
    d,
  )
  const rootFlow = await taskFlowReadStore(d).flowForTask('task-DEV-1')
  expect(started.parentFlowRecordId).toBe(rootFlow!.record_id)
})

test('queued caller starts its child, closes the queue as started, and owns the task claim', async () => {
  const d = database()
  const tasks = [row('DEV-1', null), row('DEV-2', 'DEV-1'), row('DEV-3', 'DEV-1')]
  const epic = await openEpicAtStart(d, tasks)
  await queueWorkflowChild(
    {
      project: 'fixture',
      child: 'DEV-2',
      session: 'lane-a',
      callerSession: 'epic-owner',
      off: false,
    },
    d,
  )
  const started = await startWorkflowChild(
    { project: 'fixture', cursor: epic.cursor, callerSession: 'lane-a' },
    d,
  )
  expect(started.child).toBe('DEV-2')
  expect(
    d
      .query(
        "SELECT holder_session,close_reason FROM board_claim WHERE subject_kind='queued-task' AND subject_value='DEV-2'",
      )
      .get(),
  ).toEqual({ holder_session: 'lane-a', close_reason: 'started' })
  expect(
    d
      .query(
        "SELECT holder_session FROM board_claim WHERE subject_kind='task' AND subject_value='DEV-2' AND closed_at IS NULL",
      )
      .get(),
  ).toEqual({ holder_session: 'lane-a' })
})

test('start-child does not take over a task claim that appears after selection', async () => {
  const d = database()
  const tasks = [row('DEV-1', null), row('DEV-2', 'DEV-1')]
  const epic = await openEpicAtStart(d, tasks)
  let inserted = false
  await expect(
    startWorkflowChild(
      { project: 'fixture', cursor: epic.cursor, task: 'DEV-2', callerSession: 'epic-owner' },
      d,
      {
        takeTaskClaim: async (input, context) => {
          expect(
            d.query("SELECT state FROM workflow_cursor WHERE workflow_key='DEV-2'").get(),
          ).toEqual({ state: 'running' })
          if (!inserted) {
            inserted = true
            await boardClaimTake(
              { project: 'fixture', subject: 'task:DEV-2' },
              {
                database: d,
                cwd: '/fixture',
                taskCursorAuthority: { mode: 'take', session: 'other-session' },
              },
            )
          }
          return boardClaimTake(input, context)
        },
      },
    ),
  ).rejects.toThrow(/other-session/)
  expect(d.query("SELECT state FROM workflow_cursor WHERE workflow_key='DEV-2'").get()).toEqual({
    state: 'abandoned',
  })
})

test('queue authorization belongs to the caller while the named session receives the claim', async () => {
  const d = database()
  const tasks = [row('DEV-1', null), row('DEV-2', 'DEV-1')]
  await openEpicAtStart(d, tasks)
  await expect(
    queueWorkflowChild(
      {
        project: 'fixture',
        child: 'DEV-2',
        session: 'lane-a',
        callerSession: 'unrelated',
        off: false,
      },
      d,
    ),
  ).rejects.toThrow(/calling session unrelated does not hold epic DEV-1/)
  await queueWorkflowChild(
    {
      project: 'fixture',
      child: 'DEV-2',
      session: 'fresh-lane',
      callerSession: 'epic-owner',
      off: false,
    },
    d,
  )
  expect(
    d
      .query(
        "SELECT holder_session FROM board_claim WHERE subject_kind='queued-task' AND subject_value='DEV-2' AND closed_at IS NULL",
      )
      .get(),
  ).toEqual({ holder_session: 'fresh-lane' })
})

test('queued session surface shows epic queue and open while an unrelated session shows none', async () => {
  const d = database()
  const tasks = [row('DEV-1', null), row('DEV-2', 'DEV-1'), row('DEV-3', 'DEV-1')]
  await openEpicAtStart(d, tasks)
  await queueWorkflowChild(
    {
      project: 'fixture',
      child: 'DEV-2',
      session: 'lane-a',
      callerSession: 'epic-owner',
      off: false,
    },
    d,
  )
  const lane = await sessionStopSummary({ session: 'lane-a', previousBlockKey: null }, d)
  expect(lane.lines).toContain('Epic: DEV-1')
  expect(lane.lines).toContain('Queue: DEV-2')
  expect(lane.lines).toContain('Open: DEV-3')
  const unrelated = await sessionStopSummary({ session: 'unrelated', previousBlockKey: null }, d)
  expect(unrelated.lines.some((line) => line.startsWith('Epic:'))).toBeFalse()
})

test('closing an already lapsed queued claim records lapsed instead of the requested reason', async () => {
  const d = database()
  const tasks = [row('DEV-1', null), row('DEV-2', 'DEV-1')]
  await openEpicAtStart(d, tasks)
  await queueWorkflowChild(
    {
      project: 'fixture',
      child: 'DEV-2',
      session: 'lane-a',
      callerSession: 'epic-owner',
      off: false,
    },
    d,
  )
  d.query("UPDATE board_claim SET lapses_at='2000-01-01' WHERE subject_kind='queued-task'").run()
  expect(
    await boardQueuedClaimClose(
      { project: 'fixture', key: 'DEV-2', session: 'lane-a', reason: 'released' },
      Date.now(),
      d,
    ),
  ).toEqual({ closed: 1, reason: 'lapsed' })
})
