import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  abandonWorkflowCursor,
  awaitWorkflowRuling,
  composeWorkflowWithCursor,
  decideCursorArguments,
  getWorkflowStepWithCursor,
  listWorkflowCursors,
  nextWorkflowStep,
  workflowCursorProjectScope,
} from './workflow-cursor.ts'
import { renderWorkflowComposition } from './workflow-render.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { promoteWorkflow, setWorkflow, showWorkflow } from './workflows.ts'

const database = () => {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  seedWorkflows(d)
  d.query('INSERT INTO project (name,path,stack,settings) VALUES (?,?,?,?)').run(
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({ gate: 'bun run check', trunk: 'develop', docs: { protocol: 'orch-docs' } }),
  )
  return d
}

const args = { key: 'DEV-822', branch: 'DEV-822-work', worktree: '/tmp/work' }
const context = { session: 'session-one' }

describe('workflow cursor adapter', () => {
  test('late cursor arguments merge into empty slots and conflicting values refuse', () => {
    expect(decideCursorArguments({ key: 'DEV-822' }, { branch: 'DEV-822-work' })).toEqual({
      action: 'merge',
      args: { key: 'DEV-822', branch: 'DEV-822-work' },
    })
    expect(decideCursorArguments({ key: 'DEV-822', branch: ' ' }, { branch: 'work' })).toEqual({
      action: 'merge',
      args: { key: 'DEV-822', branch: 'work' },
    })
    expect(decideCursorArguments({ key: 'DEV-822' }, { key: 'DEV-999' })).toEqual({
      action: 'refuse',
      reason:
        'workflow argument "key" conflicts with the cursor: stored value "DEV-822", supplied value "DEV-999"; run orch workflow abandon for this cursor, then compose again',
    })
  })

  test('listing scope honors explicit flags and refuses an unresolved cwd', () => {
    expect(workflowCursorProjectScope({}, 'fixture', '/fixture/worktree')).toBe('fixture')
    expect(workflowCursorProjectScope({ project: 'other' }, 'fixture', '/fixture/worktree')).toBe(
      'other',
    )
    expect(
      workflowCursorProjectScope({ session: 'session-one' }, 'fixture', '/fixture/worktree'),
    ).toBeUndefined()
    expect(
      workflowCursorProjectScope(
        { session: 'session-one', project: 'other' },
        'fixture',
        '/fixture/worktree',
      ),
    ).toBe('other')
    expect(
      workflowCursorProjectScope({ all: true }, 'fixture', '/fixture/worktree'),
    ).toBeUndefined()
    expect(() => workflowCursorProjectScope({}, undefined, '/tmp')).toThrow(
      'cannot list workflow cursors from /tmp: pass --project, --session or --all',
    )
  })

  test('compose creates once and recompose reports an advanced cursor', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    getWorkflowStepWithCursor('ship', 'fixture', 'rebase', args, 'default', context, d)
    nextWorkflowStep('ship', 'fixture', 'default', args, 'rebased', context, d)
    const recomposed = composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)

    expect(d.query('SELECT count(*) count FROM workflow_cursor').get()).toEqual({ count: 1 })
    expect(renderWorkflowComposition(recomposed)).toContain(
      'Cursor: at step 2 lens (running); continue with next.',
    )
  })

  test('abandoned cursor is retired and compose starts a fresh run', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    abandonWorkflowCursor('ship', 'fixture', 'default', args, 'operator stopped', context, d)

    const recomposed = composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)

    expect(recomposed.cursor).toMatchObject({ n: 0, slug: 'rebase', state: 'running' })
    const rows = d
      .query('SELECT id,instance_id,state,closed FROM workflow_cursor ORDER BY id')
      .all() as Array<{ id: number; instance_id: string; state: string; closed: string }>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ instance_id: `#${rows[0]!.id}`, state: 'abandoned' })
    expect(JSON.parse(rows[0]!.closed)).toMatchObject([
      { n: 1, slug: 'rebase', note: 'abandoned: operator stopped' },
    ])
    expect(rows[1]).toMatchObject({ instance_id: '', state: 'running', closed: '[]' })
  })

  test('done cursor is retired and compose starts a fresh run', () => {
    const d = database()
    const composition = composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    for (const step of composition.steps)
      nextWorkflowStep('ship', 'fixture', 'default', args, `closed ${step.slug}`, context, d)

    const recomposed = composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)

    expect(recomposed.cursor).toMatchObject({ n: 0, slug: 'rebase', state: 'running' })
    const rows = d
      .query('SELECT id,instance_id,state,closed FROM workflow_cursor ORDER BY id')
      .all() as Array<{ id: number; instance_id: string; state: string; closed: string }>
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ instance_id: `#${rows[0]!.id}`, state: 'done' })
    const closed = JSON.parse(rows[0]!.closed) as Array<{ slug: string; note: string }>
    expect(closed).toHaveLength(composition.steps.length)
    expect(closed[0]).toMatchObject({ slug: 'rebase', note: 'closed rebase' })
    expect(closed.at(-1)).toMatchObject({ slug: composition.steps.at(-1)!.slug })
    expect(rows[1]).toMatchObject({ instance_id: '', state: 'running', closed: '[]' })
  })

  test('first step fetch retires a terminal cursor and starts a fresh run', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    abandonWorkflowCursor('ship', 'fixture', 'default', args, 'operator stopped', context, d)

    getWorkflowStepWithCursor('ship', 'fixture', 'rebase', args, 'default', context, d)

    expect(
      d.query("SELECT count(*) count FROM workflow_cursor WHERE state='running'").get(),
    ).toEqual({
      count: 1,
    })
    expect(
      d.query("SELECT count(*) count FROM workflow_cursor WHERE state='abandoned'").get(),
    ).toEqual({ count: 1 })
  })

  test('step fetch on a terminal cursor directs the caller to compose again', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    abandonWorkflowCursor('ship', 'fixture', 'default', args, 'operator stopped', context, d)

    expect(() =>
      getWorkflowStepWithCursor('ship', 'fixture', 'lens', args, 'default', context, d),
    ).toThrow('workflow ship for DEV-822 is abandoned; compose it again to start a new run')
  })

  test('fetch ahead refuses, next records a note and advances', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    getWorkflowStepWithCursor('ship', 'fixture', 'rebase', args, 'default', context, d)
    expect(() =>
      getWorkflowStepWithCursor('ship', 'fixture', 'score', args, 'default', context, d),
    ).toThrow(/at step 1 rebase.*workflow next ship/)

    expect(nextWorkflowStep('ship', 'fixture', 'default', args, 'rebased', context, d)).toContain(
      'serves step 3 score',
    )
    expect(d.query('SELECT ordinal,step_slug,closed FROM workflow_cursor').get()).toMatchObject({
      ordinal: 1,
      step_slug: 'lens',
    })
    expect(
      JSON.parse(
        (d.query('SELECT closed FROM workflow_cursor').get() as { closed: string }).closed,
      )[0],
    ).toMatchObject({ n: 1, slug: 'rebase', note: 'rebased' })
  })

  test('last next marks done and open listing omits it', () => {
    const d = database()
    const composition = composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    getWorkflowStepWithCursor(
      'ship',
      'fixture',
      composition.steps[0]!.slug,
      args,
      'default',
      context,
      d,
    )
    expect(listWorkflowCursors({ project: 'fixture', session: 'session-one' }, d)).toHaveLength(1)
    expect(listWorkflowCursors({ project: 'fixture', session: 'session-one' }, d)[0]!.line).toBe(
      'ship DEV-822 fixture step 1/9 rebase running next: lens',
    )
    let output = ''
    for (const step of composition.steps) {
      output = nextWorkflowStep(
        'ship',
        'fixture',
        'default',
        args,
        `closed ${step.slug}`,
        context,
        d,
      )
    }
    expect(output).toBe(
      `Workflow ship for DEV-822 is finished: ${composition.steps.length} steps closed.`,
    )
    expect(listWorkflowCursors({ project: 'fixture', session: 'session-one' }, d)).toEqual([])
    expect(d.query('SELECT state FROM workflow_cursor').get()).toEqual({ state: 'done' })
  })

  test('keyless cursor finish text names its mode', () => {
    const d = database()
    const draft = setWorkflow(
      'keyless-fixture',
      {
        title: 'Keyless fixture',
        description: 'Exercises keyless cursor messages.',
        arguments: [],
        modes: [
          {
            slug: 'agent',
            title: 'Agent',
            default: true,
            steps: ['close'],
          },
        ],
      },
      'test fixture',
      'test',
      d,
    )
    promoteWorkflow('keyless-fixture', draft.n, 'test fixture', 'test', d)
    const keylessArgs = {}
    const keylessContext = { session: 'keyless-session' }
    const composition = composeWorkflowWithCursor(
      'keyless-fixture',
      'fixture',
      'agent',
      keylessArgs,
      keylessContext,
      d,
    )
    let output = ''

    for (const step of composition.steps)
      output = nextWorkflowStep(
        'keyless-fixture',
        'fixture',
        'agent',
        keylessArgs,
        `closed ${step.slug}`,
        keylessContext,
        d,
      )

    expect(output).toBe(
      `Workflow keyless-fixture (agent) is finished: ${composition.steps.length} steps closed.`,
    )
  })

  test('await records a question and fetching the current step resumes', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    awaitWorkflowRuling('ship', 'fixture', 'default', args, 'Which ruling?', context, d)
    expect(d.query('SELECT state,question FROM workflow_cursor').get()).toEqual({
      state: 'awaiting-ruling',
      question: 'Which ruling?',
    })

    getWorkflowStepWithCursor('ship', 'fixture', 'rebase', args, 'default', context, d)
    expect(d.query('SELECT state,question FROM workflow_cursor').get()).toEqual({
      state: 'running',
      question: null,
    })
  })

  test('abandon closes a running cursor and terminal operations refuse it', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)

    expect(
      abandonWorkflowCursor('ship', 'fixture', 'default', args, 'operator stopped', context, d),
    ).toBe('Workflow ship for DEV-822 was abandoned at step 1 rebase.')
    expect(listWorkflowCursors({ project: 'fixture', session: 'session-one' }, d)).toEqual([])
    const row = d.query('SELECT state,question,closed,session_id FROM workflow_cursor').get() as {
      state: string
      question: string | null
      closed: string
      session_id: string | null
    }
    expect(row).toMatchObject({ state: 'abandoned', question: null, session_id: 'session-one' })
    expect(JSON.parse(row.closed)).toMatchObject([
      { n: 1, slug: 'rebase', note: 'abandoned: operator stopped' },
    ])
    expect(() =>
      nextWorkflowStep('ship', 'fixture', 'default', args, 'continue', context, d),
    ).toThrow('workflow ship for DEV-822 is abandoned')
    expect(() =>
      awaitWorkflowRuling('ship', 'fixture', 'default', args, 'Question?', context, d),
    ).toThrow('workflow ship for DEV-822 is abandoned')
    expect(() =>
      abandonWorkflowCursor('ship', 'fixture', 'default', args, 'again', context, d),
    ).toThrow('workflow ship for DEV-822 is abandoned')
  })

  test('abandon clears an awaiting cursor question and records the current session', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    awaitWorkflowRuling('ship', 'fixture', 'default', args, 'Which ruling?', context, d)

    abandonWorkflowCursor(
      'ship',
      'fixture',
      'default',
      args,
      'no ruling needed',
      { session: 'session-two' },
      d,
    )

    expect(d.query('SELECT state,question,session_id FROM workflow_cursor').get()).toEqual({
      state: 'abandoned',
      question: null,
      session_id: 'session-two',
    })
    expect(listWorkflowCursors({ project: 'fixture' }, d)).toEqual([])
  })

  test('abandon requires a non-blank reason and refuses done cursors', () => {
    const d = database()
    const composition = composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    expect(() =>
      abandonWorkflowCursor('ship', 'fixture', 'default', args, '   ', context, d),
    ).toThrow('--reason is required')
    for (const step of composition.steps)
      nextWorkflowStep('ship', 'fixture', 'default', args, `closed ${step.slug}`, context, d)
    expect(() =>
      abandonWorkflowCursor('ship', 'fixture', 'default', args, 'too late', context, d),
    ).toThrow('workflow ship for DEV-822 is done')
  })

  test('an advanced cursor keeps its pinned versions and args when production moves on', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    getWorkflowStepWithCursor('ship', 'fixture', 'rebase', args, 'default', context, d)
    nextWorkflowStep('ship', 'fixture', 'default', args, 'rebased', context, d)
    const current = showWorkflow('ship', undefined, d).definition
    const draft = setWorkflow(
      'ship',
      {
        ...current,
        title: 'Ship a task (later)',
        arguments: current.arguments.filter((argument) => argument.name !== 'key'),
        modes: [{ ...current.modes[0]!, steps: ['close', 'rebase'] }],
      },
      'test fixture',
      'test',
      d,
    )
    promoteWorkflow('ship', draft.n, 'publish', 'test', d)

    expect(
      getWorkflowStepWithCursor('ship', 'fixture', '2', args, 'default', context, d).slug,
    ).toBe('lens')

    const recomposed = composeWorkflowWithCursor(
      'ship',
      'fixture',
      'default',
      { ...args, worktree: '/tmp/other' },
      context,
      d,
    )
    expect(recomposed.workflow.title).toBe('Ship a task')
    expect(recomposed.arguments.worktree).toBe('/tmp/work')
    expect(recomposed.steps.map((step) => step.slug).slice(0, 2)).toEqual(['rebase', 'lens'])
    expect(d.query('SELECT count(*) count FROM workflow_cursor').get()).toEqual({ count: 1 })
    expect(nextWorkflowStep('ship', 'fixture', 'default', args, 'lensed', context, d)).toContain(
      'serves step 4',
    )
  })

  test('a second session takes a keyed cursor over and is told so', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    getWorkflowStepWithCursor('ship', 'fixture', 'rebase', args, 'default', context, d)
    nextWorkflowStep('ship', 'fixture', 'default', args, 'rebased', context, d)
    const recomposed = composeWorkflowWithCursor(
      'ship',
      'fixture',
      'default',
      args,
      { session: 'session-two' },
      d,
    )
    expect(renderWorkflowComposition(recomposed)).toContain(
      'Cursor: at step 2 lens (running); continue with next. This cursor was driven by session session-one and is now yours.',
    )
    expect(d.query('SELECT session_id FROM workflow_cursor').get()).toEqual({
      session_id: 'session-two',
    })
    expect(listWorkflowCursors({ project: 'fixture' }, d)).toHaveLength(1)
    expect(listWorkflowCursors({ project: 'fixture', session: 'session-one' }, d)).toEqual([])
  })

  test('next uses the cursor autonomy snapshot and finish lists review steps', () => {
    const d = database()
    const preliminary = composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    d.query('DELETE FROM workflow_cursor').run()
    const resolution = {
      steps: Object.fromEntries(
        preliminary.steps.map((step) => [
          step.slug,
          {
            value: step.slug === 'rebase' ? ('review' as const) : ('auto' as const),
            scope: 'session',
          },
        ]),
      ),
      rulings: { value: 'agent' as const, scope: 'built-in' },
      session: { steps: { rebase: 'review' as const } },
    }
    const composition = composeWorkflowWithCursor(
      'ship',
      'fixture',
      'default',
      args,
      context,
      d,
      {},
      resolution,
    )
    getWorkflowStepWithCursor(
      'ship',
      'fixture',
      composition.steps[0]!.slug,
      args,
      'default',
      context,
      d,
    )
    let message = ''
    for (const step of composition.steps) {
      message = nextWorkflowStep(
        'ship',
        'fixture',
        'default',
        args,
        `closed ${step.slug}`,
        context,
        d,
      )
    }
    expect(message).toContain('For your review: 1. rebase — closed rebase')
  })

  test('a null pre-migration snapshot falls back to catalogue defaults', () => {
    const d = database()
    const resolution = {
      steps: { rebase: { value: 'review' as const, scope: 'session' } },
      rulings: { value: 'agent' as const, scope: 'built-in' },
    }
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d, {}, resolution)
    d.query('UPDATE workflow_cursor SET autonomy=NULL').run()
    getWorkflowStepWithCursor('ship', 'fixture', 'rebase', args, 'default', context, d)
    nextWorkflowStep('ship', 'fixture', 'default', args, 'rebased', context, d)
    const row = d.query('SELECT closed FROM workflow_cursor').get() as { closed: string }
    expect(JSON.parse(row.closed)[0].review).toBeUndefined()
  })
})
