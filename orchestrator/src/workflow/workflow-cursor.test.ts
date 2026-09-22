import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  abandonWorkflowCursor,
  awaitWorkflowRuling,
  composeWorkflowWithCursor,
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

  test('fetch ahead refuses, next records a note and advances', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    getWorkflowStepWithCursor('ship', 'fixture', 'rebase', args, 'default', context, d)
    expect(() =>
      getWorkflowStepWithCursor('ship', 'fixture', 'score', args, 'default', context, d),
    ).toThrow(/at step 1 rebase.*workflow next ship/)

    expect(nextWorkflowStep('ship', 'fixture', 'default', args, 'rebased', context, d)).toContain(
      'fetch step 3 score',
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
      'fetch step 4',
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
})
