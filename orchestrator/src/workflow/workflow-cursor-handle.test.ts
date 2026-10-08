import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  awaitWorkflowRuling,
  composeWorkflowWithCursor,
  getWorkflowStepWithCursor,
  nextWorkflowStep,
} from './workflow-cursor.ts'
import type { FloorEvidencePorts } from './workflow-floor-evidence.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { installWorkflowStoreFixture } from './workflow-store.fixture.ts'
import { promoteWorkflow, setWorkflow } from './workflows.ts'

const context = { session: 'session-one' }
const ports: FloorEvidencePorts = {
  readTask: (key: string) => ({
    key,
    status: 'done' as const,
    statusCategory: 'done' as const,
    commentIds: [1],
  }),
  runHasArtifacts: () => true,
  resolveCheckout: () => {
    throw new Error('checkout evidence was not expected')
  },
  viewPullRequest: () => {
    throw new Error('pull request evidence was not expected')
  },
}

function database(): Database {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  seedWorkflows(d)
  installWorkflowStoreFixture(d)
  d.query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)').run(
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({
      gate: 'bun run check',
      trunk: 'develop',
      docs: { protocol: 'orch-docs' },
      tracker: { protocol: 'hub' },
    }),
  )
  return d
}

function installKeylessWorkflow(d: Database, slug: string): void {
  const draft = setWorkflow(
    slug,
    {
      title: 'Keyless fixture',
      description: 'Exercises independent keyless runs.',
      arguments: [{ name: 'key', required: false, description: 'Task key.' }],
      modes: [{ slug: 'default', title: 'Default', default: true, steps: ['score', 'complete'] }],
    },
    'test fixture',
    'test',
    d,
  )
  promoteWorkflow(slug, draft.n, 'test fixture', 'test', d)
}

test('two keyless runs in one session have distinct handles and advance independently', () => {
  const d = database()
  installKeylessWorkflow(d, 'keyless-runs')
  const firstComposition = composeWorkflowWithCursor(
    'keyless-runs',
    'fixture',
    'default',
    {},
    context,
    d,
  )
  const secondComposition = composeWorkflowWithCursor(
    'keyless-runs',
    'fixture',
    'default',
    {},
    context,
    d,
  )
  const first = { cursor: firstComposition.cursor!.id, notice: '' }
  const second = { cursor: secondComposition.cursor!.id, notice: '' }
  expect(first.cursor).not.toBe(second.cursor)
  expect(() =>
    getWorkflowStepWithCursor(
      'keyless-runs',
      'fixture',
      'complete',
      {},
      'default',
      context,
      d,
      undefined,
      first.cursor,
    ),
  ).toThrow(`--mode default --cursor ${first.cursor}`)
  d.query("UPDATE workflow_cursor SET enforcement='note-only'").run()
  nextWorkflowStep(
    'keyless-runs',
    'fixture',
    'default',
    {},
    'first advanced',
    context,
    d,
    {},
    ports,
    first.cursor,
  )
  expect(d.query('SELECT ordinal FROM workflow_cursor WHERE id=?').get(first.cursor)).toEqual({
    ordinal: 1,
  })
  expect(d.query('SELECT ordinal FROM workflow_cursor WHERE id=?').get(second.cursor)).toEqual({
    ordinal: 0,
  })
  expect(() =>
    nextWorkflowStep('keyless-runs', 'fixture', 'default', {}, 'ambiguous', context, d, {}, ports),
  ).toThrow(
    `more than one open keyless workflow cursor matches; pass a cursor handle:\n` +
      `cursor ${first.cursor}, unassigned, keyless-runs default, step 2 complete\n` +
      `cursor ${second.cursor}, unassigned, keyless-runs default, step 1 score`,
  )
})

test('step 1 reuses one untouched composed keyless cursor but opens after it advances', () => {
  const d = database()
  installKeylessWorkflow(d, 'compose-then-step')
  const composed = composeWorkflowWithCursor(
    'compose-then-step',
    'fixture',
    'default',
    {},
    context,
    d,
  )
  const first = getWorkflowStepWithCursor(
    'compose-then-step',
    'fixture',
    'score',
    {},
    'default',
    context,
    d,
  )
  expect(first.cursor).toBe(composed.cursor!.id)
  expect(d.query('SELECT count(*) AS n FROM workflow_cursor').get()).toEqual({ n: 1 })

  d.query("UPDATE workflow_cursor SET enforcement='note-only'").run()
  nextWorkflowStep(
    'compose-then-step',
    'fixture',
    'default',
    {},
    'advanced',
    context,
    d,
    {},
    ports,
    first.cursor,
  )
  const second = getWorkflowStepWithCursor(
    'compose-then-step',
    'fixture',
    'score',
    {},
    'default',
    context,
    d,
  )
  expect(second.cursor).not.toBe(first.cursor)
  expect(d.query('SELECT count(*) AS n FROM workflow_cursor').get()).toEqual({ n: 2 })
})

test('step 1 ignores two advanced keyless cursors and opens a third', () => {
  const d = database()
  installKeylessWorkflow(d, 'advanced-keyless-runs')
  const first = composeWorkflowWithCursor(
    'advanced-keyless-runs',
    'fixture',
    'default',
    {},
    context,
    d,
  ).cursor!.id
  const second = composeWorkflowWithCursor(
    'advanced-keyless-runs',
    'fixture',
    'default',
    {},
    context,
    d,
  ).cursor!.id
  d.query("UPDATE workflow_cursor SET enforcement='note-only'").run()
  for (const cursor of [first, second])
    nextWorkflowStep(
      'advanced-keyless-runs',
      'fixture',
      'default',
      {},
      'advanced',
      context,
      d,
      {},
      ports,
      cursor,
    )

  const third = getWorkflowStepWithCursor(
    'advanced-keyless-runs',
    'fixture',
    'score',
    {},
    'default',
    context,
    d,
  )
  expect([first, second]).not.toContain(third.cursor)
  expect(d.query('SELECT count(*) AS n FROM workflow_cursor').get()).toEqual({ n: 3 })
})

test('step 1 reuses the untouched cursor when another keyless cursor is advanced', () => {
  const d = database()
  installKeylessWorkflow(d, 'mixed-keyless-runs')
  const advanced = composeWorkflowWithCursor(
    'mixed-keyless-runs',
    'fixture',
    'default',
    {},
    context,
    d,
  ).cursor!.id
  const untouched = composeWorkflowWithCursor(
    'mixed-keyless-runs',
    'fixture',
    'default',
    {},
    context,
    d,
  ).cursor!.id
  d.query("UPDATE workflow_cursor SET enforcement='note-only'").run()
  nextWorkflowStep(
    'mixed-keyless-runs',
    'fixture',
    'default',
    {},
    'advanced',
    context,
    d,
    {},
    ports,
    advanced,
  )

  const fetched = getWorkflowStepWithCursor(
    'mixed-keyless-runs',
    'fixture',
    'score',
    {},
    'default',
    context,
    d,
  )
  expect(fetched.cursor).toBe(untouched)
  expect(d.query('SELECT count(*) AS n FROM workflow_cursor').get()).toEqual({ n: 2 })
})

test('step 1 reuses a cursor whose trail contains only an argument rebound', () => {
  const d = database()
  installKeylessWorkflow(d, 'rebound-keyless-run')
  const opened = composeWorkflowWithCursor(
    'rebound-keyless-run',
    'fixture',
    'default',
    {},
    context,
    d,
  ).cursor!.id
  d.query('UPDATE workflow_cursor SET closed=? WHERE id=?').run(
    JSON.stringify([
      {
        event: 'argument-rebound',
        name: 'description',
        oldValue: 'before',
        newValue: 'after',
        at: '2026-10-05T00:00:00.000Z',
      },
    ]),
    opened,
  )

  const fetched = getWorkflowStepWithCursor(
    'rebound-keyless-run',
    'fixture',
    'score',
    {},
    'default',
    context,
    d,
  )
  expect(fetched.cursor).toBe(opened)
  expect(d.query('SELECT count(*) AS n FROM workflow_cursor').get()).toEqual({ n: 1 })
})

test('step 1 refuses when two untouched keyless cursors match', () => {
  const d = database()
  installKeylessWorkflow(d, 'untouched-keyless-runs')
  const first = composeWorkflowWithCursor(
    'untouched-keyless-runs',
    'fixture',
    'default',
    {},
    context,
    d,
  ).cursor!.id
  const second = composeWorkflowWithCursor(
    'untouched-keyless-runs',
    'fixture',
    'default',
    {},
    context,
    d,
  ).cursor!.id

  expect(() =>
    getWorkflowStepWithCursor(
      'untouched-keyless-runs',
      'fixture',
      'score',
      {},
      'default',
      context,
      d,
    ),
  ).toThrow(
    `more than one open keyless workflow cursor matches; pass a cursor handle:\n` +
      `cursor ${first}, unassigned, untouched-keyless-runs default, step 1 score\n` +
      `cursor ${second}, unassigned, untouched-keyless-runs default, step 1 score`,
  )
})

test('a handle to a done or abandoned cursor never opens a replacement', () => {
  for (const state of ['done', 'abandoned'] as const) {
    const d = database()
    installKeylessWorkflow(d, `retired-${state}`)
    const opened = getWorkflowStepWithCursor(
      `retired-${state}`,
      'fixture',
      'score',
      {},
      'default',
      context,
      d,
    )
    d.query('UPDATE workflow_cursor SET state=? WHERE id=?').run(state, opened.cursor)
    expect(() =>
      getWorkflowStepWithCursor(
        `retired-${state}`,
        'fixture',
        'score',
        {},
        'default',
        context,
        d,
        undefined,
        opened.cursor,
      ),
    ).toThrow(
      `cursor ${opened.cursor} is ${state}; a new run is opened by fetching step 1 without a handle`,
    )
    expect(d.query('SELECT count(*) AS n FROM workflow_cursor').get()).toEqual({ n: 1 })
  }
})

test('a handle validates supplied identity and serves the active step for an earlier request', () => {
  const d = database()
  const args = { key: 'DEV-822', branch: 'DEV-822-work', worktree: '/tmp/work' }
  const opened = getWorkflowStepWithCursor('flow', 'fixture', 'rebase', args, 'default', context, d)
  d.query("UPDATE workflow_cursor SET enforcement='note-only' WHERE id=?").run(opened.cursor)
  nextWorkflowStep(
    'flow',
    'fixture',
    'default',
    args,
    'advanced',
    context,
    d,
    {},
    ports,
    opened.cursor,
  )
  const served = getWorkflowStepWithCursor(
    'flow',
    'fixture',
    'rebase',
    args,
    'default',
    context,
    d,
    undefined,
    opened.cursor,
  )
  expect(served.slug).toBe('lens')
  expect(served.notice).toContain('Requested step 1 rebase; serving active step 2 lens.')
  expect(() =>
    getWorkflowStepWithCursor(
      'flow',
      'wrong-project',
      'lens',
      args,
      'default',
      context,
      d,
      undefined,
      opened.cursor,
    ),
  ).toThrow(`cursor ${opened.cursor} project mismatch`)
})

test('closing with task adopts a key once and rekeys cursor questions', () => {
  const d = database()
  installKeylessWorkflow(d, 'adopt-key')
  const opened = getWorkflowStepWithCursor(
    'adopt-key',
    'fixture',
    'score',
    {},
    'default',
    context,
    d,
  )
  awaitWorkflowRuling(
    'adopt-key',
    'fixture',
    'default',
    {},
    'Which task?',
    context,
    d,
    () => {},
    opened.cursor,
  )
  d.query("UPDATE workflow_cursor SET enforcement='note-only' WHERE id=?").run(opened.cursor)
  nextWorkflowStep(
    'adopt-key',
    'fixture',
    'default',
    {},
    'task created',
    context,
    d,
    { task: 'DEV-1082' },
    ports,
    opened.cursor,
  )
  const adopted = d
    .query('SELECT workflow_key,instance_id,args FROM workflow_cursor WHERE id=?')
    .get(opened.cursor) as { workflow_key: string; instance_id: string; args: string }
  expect(adopted.workflow_key).toBe('DEV-1082')
  expect(adopted.instance_id).toBe('')
  expect(JSON.parse(adopted.args).key).toBe('DEV-1082')
  expect(d.query('SELECT workflow_key FROM question').get()).toEqual({ workflow_key: 'DEV-1082' })
  const outbox = d
    .query<{ payload: string }, []>("SELECT payload FROM outbox WHERE kind='question'")
    .get()!
  expect(JSON.parse(outbox.payload)).toMatchObject({ workflowKey: 'DEV-1082', revision: 3 })
  const keyedArgs = { key: 'DEV-1082' }
  expect(
    getWorkflowStepWithCursor('adopt-key', 'fixture', 'complete', keyedArgs, 'default', context, d)
      .cursor,
  ).toBe(opened.cursor)
  expect(
    composeWorkflowWithCursor('adopt-key', 'fixture', 'default', keyedArgs, context, d).cursor?.id,
  ).toBe(opened.cursor)
  expect(
    awaitWorkflowRuling('adopt-key', 'fixture', 'default', keyedArgs, 'Done?', context, d, () => {})
      .id,
  ).toBe(opened.cursor)
  expect(() =>
    nextWorkflowStep(
      'adopt-key',
      'fixture',
      'default',
      {},
      'different task',
      context,
      d,
      { task: 'DEV-9999' },
      ports,
      opened.cursor,
    ),
  ).toThrow(`cursor ${opened.cursor} is already assigned to DEV-1082`)
  nextWorkflowStep('adopt-key', 'fixture', 'default', keyedArgs, 'completed', context, d, {}, ports)
  expect(
    d.query('SELECT count(*) AS n FROM workflow_cursor WHERE workflow_key=?').get('DEV-1082'),
  ).toEqual({ n: 1 })
})

test('adoption refuses a key held by another open cursor', () => {
  const d = database()
  installKeylessWorkflow(d, 'adopt-conflict')
  const keyed = getWorkflowStepWithCursor(
    'adopt-conflict',
    'fixture',
    'score',
    { key: 'DEV-1082' },
    'default',
    context,
    d,
  )
  const keyless = getWorkflowStepWithCursor(
    'adopt-conflict',
    'fixture',
    'score',
    {},
    'default',
    context,
    d,
  )
  d.query("UPDATE workflow_cursor SET enforcement='note-only'").run()
  expect(() =>
    nextWorkflowStep(
      'adopt-conflict',
      'fixture',
      'default',
      {},
      'task created',
      context,
      d,
      { task: 'DEV-1082' },
      ports,
      keyless.cursor,
    ),
  ).toThrow(
    `cursor ${keyless.cursor} cannot adopt DEV-1082; open cursor ${keyed.cursor} already holds it`,
  )
})
