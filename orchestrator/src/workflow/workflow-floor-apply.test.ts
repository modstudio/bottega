import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { boardClaimList } from '../board/board-operations.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import { installTaskReader, type TaskReadPort } from './task-read-port.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import {
  args,
  context,
  database,
  selectAndNextWorkflowStep,
} from './workflow-cursor-test.fixture.ts'
import type { Floor } from './workflow-floor.ts'
import { applyFloorDecision } from './workflow-floor-apply.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

const floorDatabase = testDatabaseFixture((d) => {
  d.query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)').run(
    newRecordId(),
    'fixture',
    '/fixture',
    JSON.stringify({ trunk: 'main', tracker: { states: { active: 'active' } } }),
  )
})

const task = {
  key: 'DEV-1',
  record_id: 'task-1',
  project: 'fixture',
  title: 'Epic candidate',
  parent_key: null,
  source: 'fixture',
  status: 'Active',
  status_category: 'active',
  last_seen: null,
  body: null,
  opened_at: null,
}

const taskPort: TaskReadPort = {
  list: () => [task],
  show: () => ({ task }),
  duplicates: () => [],
  documents: () => [],
  document: () => ({ id: 'none', label: 'none', title: 'none', body: '', version: '1' }),
}

const floor = (kind: Floor['kind']): Floor => ({
  kind,
  deferrable: false,
  expectedExitCode: 0,
  expectedStatus: 'active',
  requirePullRequest: false,
  operatorRuling: false,
})

function installKeylessWorkflow(
  d: ReturnType<typeof database>,
  slug: string,
  steps: readonly string[],
) {
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogueLocal(
    {
      ...current,
      steps: [
        ...current.steps,
        ...steps.map((slug) => ({
          slug,
          title: slug,
          body: `Close ${slug}.`,
          stage: 'plan' as const,
          floor: ['recorded-artifact' as const],
          jobs: [],
          actions: [],
          autonomy: 'auto' as const,
          needs: [],
        })),
      ],
    },
    'keyless ownership fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(catalogue.n, 'keyless ownership fixture', 'test', d)
  const draft = setWorkflowLocal(
    slug,
    {
      title: slug,
      description: 'Exercises keyless cursor ownership on close.',
      arguments: [],
      modes: [{ slug: 'default', title: 'Default', default: true, steps }],
    },
    'keyless ownership fixture',
    'test',
    d,
  )
  promoteWorkflowLocal(slug, draft.n, 'keyless ownership fixture', 'test', d)
}

test.each([
  { name: 'advance', steps: ['ownership-first', 'ownership-last'] },
  { name: 'finish', steps: ['ownership-first'] },
  {
    name: 'advance with task adoption',
    steps: ['ownership-first', 'ownership-last'],
    task: 'DEV-2422',
  },
])('a foreign keyless $name refuses before writing', async ({ steps, task }) => {
  const d = database()
  const slug = `keyless-foreign-${steps.length}`
  installKeylessWorkflow(d, slug, steps)
  const owner = { session: 'owner-session' }
  const keylessArgs = {}
  const opened = await composeWorkflowWithCursor(
    slug,
    'fixture',
    'default',
    keylessArgs,
    owner,
    d,
    {},
    {},
  )
  const cursor = opened.cursor!.id
  d.query("UPDATE workflow_cursor SET enforcement='note-only' WHERE number=?").run(cursor)

  await expect(
    selectAndNextWorkflowStep(
      slug,
      'fixture',
      'default',
      keylessArgs,
      'closed by foreign session',
      { session: 'foreign-session' },
      d,
      task ? { task } : {},
      undefined,
      cursor,
    ),
  ).rejects.toThrow(
    `workflow cursor ${cursor} is owned by session owner-session; a keyless cursor changes owner only through an explicit takeover. Take it over with: ${PLATFORM_SLUG} workflow abandon --cursor ${cursor} --project fixture --owner-session owner-session; then compose a new cursor with: ${PLATFORM_SLUG} workflow compose ${slug} --project fixture --mode default`,
  )
  expect(
    d
      .query('SELECT session_id,workflow_key,ordinal,state FROM workflow_cursor WHERE number=?')
      .get(cursor),
  ).toEqual({ session_id: 'owner-session', workflow_key: '', ordinal: 0, state: 'running' })
})

test('plan-task start refuses zero dispatches without creating review debt', async () => {
  installTaskReader(taskPort)
  let reviewOwedCalls = 0
  const result = await applyFloorDecision(
    {
      id: 1,
      record_id: newRecordId(),
      project: 'fixture',
      workflow_slug: 'plan-task',
      mode_slug: 'default',
      workflow_key: 'DEV-1',
      task_record_id: null,
      args: '{"key":"DEV-1"}',
      session_id: 'session-a',
      created_at: '2026-11-19T00:00:00.000Z',
      ordinal: 1,
      step_slug: 'start',
      state: 'running',
      closed: '[{"n":1,"slug":"write","note":"planned","at":"2026-11-19T00:00:00.000Z"}]',
      enforcement: 'floors',
    },
    [floor('tracker-transition'), floor('descendants-closed')],
    { slug: 'start', jobs: ['implement'], dispatch: 'required' },
    { task: 'DEV-1' },
    {
      readTask: (key) => ({
        key,
        status: 'Active',
        statusCategory: 'active',
        commentIds: [],
      }),
      reviewOwed: () => {
        reviewOwedCalls++
        throw new Error('review-owed must not be consulted')
      },
    },
    true,
    floorDatabase(),
  )
  expect(result).toMatchObject({ action: 'refuse' })
  if (result.action === 'refuse')
    expect(result.message).toContain('no implement run was dispatched from this cursor')
  expect(reviewOwedCalls).toBe(0)
})

test.each([
  [true, 'allow'],
  [false, 'refuse'],
] as const)(
  'review-lenses no-lens-owed=%s decides the zero-run waiver',
  async (noLensOwed, action) => {
    const result = await applyFloorDecision(
      {
        id: 2,
        record_id: newRecordId(),
        project: 'fixture',
        workflow_slug: 'fix-defect',
        mode_slug: 'default',
        workflow_key: 'DEV-1',
        task_record_id: null,
        args: '{"key":"DEV-1","branch":"DEV-1-fix"}',
        session_id: 'session-a',
        created_at: '2026-11-19T00:00:00.000Z',
        ordinal: 0,
        step_slug: 'review-lenses',
        state: 'running',
        closed: '[]',
        enforcement: 'floors',
      },
      [floor('review-owed')],
      {
        slug: 'review-lenses',
        jobs: ['review-lens'],
        dispatch: 'required',
        dispatchWaivedBy: ['no-lens-owed'],
      },
      {},
      { reviewOwed: () => ({ action: 'allow', noLensOwed }) },
      false,
      floorDatabase(),
    )
    expect(result.action).toBe(action)
  },
)

test('an unresolvable waiver branch refuses with the required arguments and does not waive', async () => {
  const result = await applyFloorDecision(
    {
      id: 3,
      record_id: newRecordId(),
      project: 'fixture',
      workflow_slug: 'fix-defect',
      mode_slug: 'default',
      workflow_key: 'DEV-1',
      task_record_id: null,
      args: '{"key":"DEV-1","branch":"missing-branch"}',
      session_id: 'session-a',
      created_at: '2026-11-19T00:00:00.000Z',
      ordinal: 0,
      step_slug: 'apply-findings',
      state: 'running',
      closed: '[]',
      enforcement: 'floors',
    },
    [],
    {
      slug: 'apply-findings',
      jobs: ['implement'],
      dispatch: 'required',
      dispatchWaivedBy: ['no-accepted-findings'],
    },
    {},
    {},
    false,
    floorDatabase(),
  )

  expect(result).toEqual({
    action: 'refuse',
    message: expect.stringMatching(
      /no-accepted-findings cannot be established: cannot resolve the current tip of branch missing-branch[\s\S]*--arg worktree=<path>[\s\S]*--arg branch=<branch>/,
    ),
  })
})

test('a foreign keyed advance keeps the recorded taken-over claim behavior', async () => {
  const d = database()
  await composeWorkflowWithCursor('flow', 'fixture', 'default', args, context, d, {}, {})
  d.query("UPDATE workflow_cursor SET enforcement='note-only'").run()

  await selectAndNextWorkflowStep(
    'flow',
    'fixture',
    'default',
    args,
    'closed by foreign session',
    { ...context, session: 'foreign-session' },
    d,
  )

  const claims = (
    await boardClaimList('fixture', true, {
      env: {},
      database: d,
      taskCursorAuthority: { mode: 'coverage-read', session: null },
    })
  ).claims
  expect(claims).toHaveLength(2)
  expect(claims[0]).toMatchObject({ holder: 'session-one', closeReason: 'taken-over' })
  expect(claims[1]).toMatchObject({ holder: 'foreign-session', live: true })
})
