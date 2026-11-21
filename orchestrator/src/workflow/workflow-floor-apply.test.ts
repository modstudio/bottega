import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { boardClaimList } from '../board/board-operations.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import {
  completeReview,
  gradeReviewLens,
  recordReview,
  triageFinding,
} from '../review/review-triage.ts'
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
import { gatherNoAcceptedFindingsFact } from './workflow-dispatch-waiver-evidence.ts'
import type { Floor } from './workflow-floor.ts'
import { applyFloorDecision, readDescendantTaskFacts } from './workflow-floor-apply.ts'
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
  list: async () => [task],
  show: async () => ({ task }),
  duplicates: async () => [],
  documents: async () => [],
  document: async () => ({ id: 'none', label: 'none', title: 'none', body: '', version: '1' }),
}

test('descendant facts use parent-filtered reads and visit each node once', async () => {
  const reads: Array<{ project?: string; parent?: string }> = []
  const children = new Map([
    ['DEV-1', [{ ...task, key: 'DEV-2', parent_key: 'DEV-1' }]],
    ['DEV-2', [{ ...task, key: 'DEV-3', parent_key: 'DEV-2' }]],
    ['DEV-3', [{ ...task, key: 'DEV-2', parent_key: 'DEV-3' }]],
  ])
  installTaskReader({
    ...taskPort,
    list: async (filters = {}) => {
      reads.push(filters)
      return children.get(filters.parent ?? '') ?? []
    },
  })

  await expect(readDescendantTaskFacts('fixture', 'DEV-1')).resolves.toHaveLength(2)
  expect(reads).toEqual([
    { project: 'fixture', parent: 'DEV-1' },
    { project: 'fixture', parent: 'DEV-2' },
    { project: 'fixture', parent: 'DEV-3' },
  ])
})

test('descendant facts make no reads without a root key', async () => {
  let reads = 0
  installTaskReader({
    ...taskPort,
    list: async () => {
      reads += 1
      return []
    },
  })

  await expect(readDescendantTaskFacts('fixture', '')).resolves.toEqual([])
  expect(reads).toBe(0)
})

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

function noAcceptedFindingsFixture() {
  const repository = mkdtempSync(join(tmpdir(), 'workflow-no-accepted-findings-'))
  const git = (...args: string[]) => {
    const result = spawnFixtureGitSync(args, { cwd: repository })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  try {
    git('init', '-b', 'main')
    git('config', 'user.email', 'fixture@example.com')
    git('config', 'user.name', 'Fixture')
    writeFileSync(join(repository, 'file.txt'), 'base\n')
    git('add', 'file.txt')
    git('commit', '-m', 'base')
    git('checkout', '-b', 'DEV-1-change')
    writeFileSync(join(repository, 'file.txt'), 'changed\n')
    git('commit', '-am', 'change')
    const d = floorDatabase()
    const projectRecordId = newRecordId()
    d.query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)').run(
      projectRecordId,
      'waiver-fixture',
      repository,
      JSON.stringify({ trunk: 'main' }),
    )
    const head = spawnFixtureGitSync(['rev-parse', 'HEAD'], { cwd: repository })
    if (head.exitCode !== 0) throw new Error(head.stderr.toString())
    return {
      d,
      head: head.stdout.toString().trim(),
      projectRecordId,
      repository,
      dispose: () => rmSync(repository, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(repository, { recursive: true, force: true })
    throw error
  }
}

test('no measured review round establishes no accepted findings', () => {
  const fixture = noAcceptedFindingsFixture()
  try {
    expect(
      gatherNoAcceptedFindingsFact(
        'waiver-fixture',
        { worktree: fixture.repository, branch: 'DEV-1-change' },
        fixture.d,
      ),
    ).toEqual({ action: 'allow', facts: ['no-accepted-findings'] })
  } finally {
    fixture.dispose()
  }
})

test('a measured review round with an accepted finding withholds no accepted findings', () => {
  const fixture = noAcceptedFindingsFixture()
  try {
    const runRecordId = newRecordId()
    fixture.d
      .query(
        `INSERT INTO run
           (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,
            project_record_id,branch,head_commit,lens,model)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-11-19','codex','review-lens',
                 'sha',1,'head','ok','waiver-fixture',?,'DEV-1-change',?,'correctness','fixture-model')`,
      )
      .run(runRecordId, fixture.projectRecordId, fixture.head)
    const output = reviewReply(1, 'high')
    const reviewRecordId = recordReview(runRecordId, output, fixture.d)
    gradeReviewLens(
      runRecordId,
      output,
      { reproduced: 'all', coverage: 'adequate', limits: 'absent', overlap: 'none' },
      fixture.d,
    )
    triageFinding(reviewRecordId, 1, 'accepted', undefined, 'high', fixture.d)
    completeReview(reviewRecordId, fixture.d)

    expect(
      gatherNoAcceptedFindingsFact(
        'waiver-fixture',
        { worktree: fixture.repository, branch: 'DEV-1-change' },
        fixture.d,
      ),
    ).toEqual({ action: 'allow', facts: [] })
  } finally {
    fixture.dispose()
  }
})

test('an unmeasured review with an accepted finding withholds no accepted findings', () => {
  const fixture = noAcceptedFindingsFixture()
  try {
    const runRecordId = newRecordId()
    fixture.d
      .query(
        `INSERT INTO run
           (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,
            project_record_id,branch,lens,model)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-11-19','codex','review-lens',
                 'sha',1,'head','ok','waiver-fixture',?,'DEV-1-change','correctness','fixture-model')`,
      )
      .run(runRecordId, fixture.projectRecordId)
    const output = reviewReply(1, 'high')
    const reviewRecordId = recordReview(runRecordId, output, fixture.d)
    gradeReviewLens(
      runRecordId,
      output,
      { reproduced: 'all', coverage: 'adequate', limits: 'absent', overlap: 'none' },
      fixture.d,
    )
    triageFinding(reviewRecordId, 1, 'accepted', undefined, 'high', fixture.d)
    completeReview(reviewRecordId, fixture.d)

    expect(
      gatherNoAcceptedFindingsFact(
        'waiver-fixture',
        { worktree: fixture.repository, branch: 'DEV-1-change' },
        fixture.d,
      ),
    ).toEqual({ action: 'allow', facts: [] })
  } finally {
    fixture.dispose()
  }
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
