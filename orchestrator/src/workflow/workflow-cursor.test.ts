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
  ruleWorkflow,
  workflowCursorProjectScope,
} from './workflow-cursor.ts'
import type { WorkflowEvidenceInput } from './workflow-floor-evidence.ts'
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
    JSON.stringify({
      gate: 'bun run check',
      trunk: 'develop',
      docs: { protocol: 'orch-docs' },
      tracker: { protocol: 'hub' },
    }),
  )
  return d
}

const args = { key: 'DEV-822', branch: 'DEV-822-work', worktree: '/tmp/work' }
const context = { session: 'session-one' }

const testPorts = {
  readTask: (key: string) => ({
    key,
    status: 'done' as const,
    statusCategory: 'done' as const,
    commentIds: [1],
  }),
  runHasArtifacts: () => true,
  resolveCheckout: () => ({
    project: 'fixture',
    branch: 'DEV-822-work',
    headIsTipOrAncestor: true,
  }),
  viewPullRequest: () => ({ state: 'MERGED', mergedAt: '2026-09-01' }),
}

function installEvidence(
  d: Database,
  project: string,
  slug: string,
  mode: string,
  callArgs: Record<string, string>,
  callContext: { session?: string | null; instance?: string },
): WorkflowEvidenceInput {
  const key = callArgs.key?.trim() ?? ''
  const instance = key ? '' : (callContext.session ?? callContext.instance ?? '')
  const row = d
    .query<{ id: number; ordinal: number; step_slug: string; state: string }, string[]>(
      `SELECT id,ordinal,step_slug,state FROM workflow_cursor
        WHERE project=? AND workflow_slug=? AND mode_slug=? AND workflow_key=? AND instance_id=?`,
    )
    .get(project, slug, mode, key, instance)
  if (!row || row.state === 'done' || row.state === 'abandoned') return {}
  const gate =
    d
      .query<{ id: number }, []>(
        `SELECT id FROM gate_execution WHERE finished_at IS NOT NULL AND exit_code=0 LIMIT 1`,
      )
      .get()?.id ??
    (
      d
        .query<{ id: number }, []>(
          `INSERT INTO gate_execution (run_id,requested_at,started_at,finished_at,exit_code,cwd,head_commit)
         VALUES (NULL,'2026-09-01','2026-09-01','2026-09-01',0,'/tmp/work','abc') RETURNING id`,
        )
        .get() as { id: number }
    ).id
  const probe =
    d.query<{ id: number }, []>('SELECT id FROM probe LIMIT 1').get()?.id ??
    (
      d
        .query<{ id: number }, []>(
          `INSERT INTO probe (command,cwd,head_commit,exit_code,output_tail,created_at)
           VALUES ('["true"]','/tmp','abc',0,'','2026-09-01') RETURNING id`,
        )
        .get() as { id: number }
    ).id
  const taskKey = key || 'DEV-822'
  d.query(
    `INSERT OR IGNORE INTO branch_landing_record
      (project,branch,tip,pr_number,merge_commit,merged_at,recorded_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(project, `${taskKey}-work`, 'abc', 1, 'def', '2026-09-01', '2026-09-01')
  const ruling = d
    .query<{ id: number }, (string | number | null)[]>(
      `INSERT INTO question
        (workflow_cursor_id,workflow_key,asked_at,question,asked_via,answered_at,answer,
         workflow_step_ordinal,workflow_step_slug)
       VALUES (?,?,?,?, 'workflow', ?, 'yes', ?, ?) RETURNING id`,
    )
    .get(
      row.id,
      key || null,
      '2026-09-01',
      'floor ruling?',
      '2026-09-01',
      row.ordinal + 1,
      row.step_slug,
    ) as { id: number }
  return { gate, artifact: `probe:${probe}`, ruling: ruling.id, task: taskKey }
}

function closeStep(
  slug: string,
  project: string,
  mode: string,
  callArgs: Record<string, string>,
  note: string | undefined,
  callContext: { session?: string | null; instance?: string },
  d: Database,
) {
  return nextWorkflowStep(
    slug,
    project,
    mode,
    callArgs,
    note,
    callContext,
    d,
    installEvidence(d, project, slug, mode, callArgs, callContext),
    testPorts,
  )
}

describe('workflow cursor adapter', () => {
  test('late cursor arguments merge into empty slots and conflicting values refuse', () => {
    const none = new Set<string>()
    expect(decideCursorArguments({ key: 'DEV-822' }, { branch: 'DEV-822-work' }, none)).toEqual({
      action: 'merge',
      args: { key: 'DEV-822', branch: 'DEV-822-work' },
      rebindings: [],
    })
    expect(
      decideCursorArguments({ key: 'DEV-822', branch: ' ' }, { branch: 'work' }, none),
    ).toEqual({
      action: 'merge',
      args: { key: 'DEV-822', branch: 'work' },
      rebindings: [],
    })
    expect(
      decideCursorArguments(
        { key: 'DEV-822', worktree: '/tmp/old' },
        { worktree: '/tmp/new' },
        new Set(['worktree']),
      ),
    ).toEqual({
      action: 'merge',
      args: { key: 'DEV-822', worktree: '/tmp/new' },
      rebindings: [{ name: 'worktree', oldValue: '/tmp/old', newValue: '/tmp/new' }],
    })
    expect(
      decideCursorArguments(
        { key: 'DEV-822', branch: 'DEV-822-work' },
        { branch: 'DEV-999-work' },
        none,
      ),
    ).toEqual({
      action: 'refuse',
      reason:
        'workflow argument "branch" conflicts with the cursor: stored value "DEV-822-work", supplied value "DEV-999-work"; run orch workflow abandon for this cursor, then compose again',
    })
    expect(decideCursorArguments({ key: 'DEV-822' }, { key: 'DEV-999' }, new Set(['key']))).toEqual(
      {
        action: 'refuse',
        reason:
          'workflow argument "key" conflicts with the cursor: stored value "DEV-822", supplied value "DEV-999"; run orch workflow abandon for this cursor, then compose again',
      },
    )
  })

  test('next advances with a rebound argument from the pinned workflow and records the event', () => {
    const d = database()
    const draft = setWorkflow(
      'rebind-fixture',
      {
        title: 'Rebind fixture',
        description: 'Exercises cursor argument rebinding.',
        arguments: [
          { name: 'key', required: true, description: 'Task key.' },
          { name: 'worktree', required: true, rebind: true, description: 'Worktree path.' },
        ],
        modes: [
          {
            slug: 'default',
            title: 'Default',
            default: true,
            steps: ['lens', 'score'],
          },
        ],
      },
      'test fixture',
      'test',
      d,
    )
    promoteWorkflow('rebind-fixture', draft.n, 'test fixture', 'test', d)
    composeWorkflowWithCursor(
      'rebind-fixture',
      'fixture',
      'default',
      { key: 'DEV-822', worktree: '/tmp/old' },
      context,
      d,
    )

    expect(
      closeStep(
        'rebind-fixture',
        'fixture',
        'default',
        { key: 'DEV-822', worktree: '/tmp/new' },
        'reviewed',
        context,
        d,
      ),
    ).toContain('this is the last step of rebind-fixture')
    const row = d.query('SELECT args,closed FROM workflow_cursor').get() as {
      args: string
      closed: string
    }
    expect(JSON.parse(row.args).worktree).toBe('/tmp/new')
    expect(JSON.parse(row.closed)).toEqual([
      expect.objectContaining({
        event: 'argument-rebound',
        name: 'worktree',
        oldValue: '/tmp/old',
        newValue: '/tmp/new',
      }),
      expect.objectContaining({ n: 1, slug: 'lens', note: 'reviewed' }),
    ])
  })

  test('a current production declaration can rebind an argument for an older pinned cursor', () => {
    const d = database()
    const definition = {
      title: 'Policy fixture',
      description: 'Exercises production rebind policy.',
      arguments: [
        { name: 'key', required: true, description: 'Task key.' },
        { name: 'worktree', required: true, description: 'Worktree path.' },
      ],
      modes: [
        {
          slug: 'default',
          title: 'Default',
          default: true,
          steps: ['lens', 'score'],
        },
      ],
    }
    const original = setWorkflow('policy-fixture', definition, 'test fixture', 'test', d)
    promoteWorkflow('policy-fixture', original.n, 'test fixture', 'test', d)
    composeWorkflowWithCursor(
      'policy-fixture',
      'fixture',
      'default',
      { key: 'DEV-822', worktree: '/tmp/old' },
      context,
      d,
    )
    const current = setWorkflow(
      'policy-fixture',
      {
        ...definition,
        arguments: definition.arguments.map((argument) =>
          argument.name === 'worktree' ? { ...argument, rebind: true } : argument,
        ),
      },
      'test fixture',
      'test',
      d,
    )
    promoteWorkflow('policy-fixture', current.n, 'test fixture', 'test', d)

    expect(
      closeStep(
        'policy-fixture',
        'fixture',
        'default',
        { key: 'DEV-822', worktree: '/tmp/new' },
        'reviewed',
        context,
        d,
      ),
    ).toContain('this is the last step of policy-fixture')
    const row = d.query('SELECT workflow_version,args FROM workflow_cursor').get() as {
      workflow_version: number
      args: string
    }
    expect(row.workflow_version).toBe(original.n)
    expect(JSON.parse(row.args).worktree).toBe('/tmp/new')
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
    closeStep('ship', 'fixture', 'default', args, 'rebased', context, d)
    const recomposed = composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)

    expect(d.query('SELECT count(*) count FROM workflow_cursor').get()).toEqual({ count: 1 })
    expect(renderWorkflowComposition(recomposed)).toContain(
      'Cursor: at step 2 lens (running); continue with next.',
    )
  })

  test('recompose persists and renders a rebound argument while refusing other conflicts', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)

    const reopenedArgs = { ...args, worktree: '/tmp/reopened' }
    const recomposed = composeWorkflowWithCursor(
      'ship',
      'fixture',
      'default',
      reopenedArgs,
      context,
      d,
    )

    expect(recomposed.arguments.worktree).toBe('/tmp/reopened')
    expect(renderWorkflowComposition(recomposed)).toContain('--arg worktree=/tmp/reopened')
    const row = d.query('SELECT args,closed FROM workflow_cursor').get() as {
      args: string
      closed: string
    }
    expect(JSON.parse(row.args).worktree).toBe('/tmp/reopened')
    expect(JSON.parse(row.closed)).toContainEqual(
      expect.objectContaining({
        event: 'argument-rebound',
        name: 'worktree',
        oldValue: '/tmp/work',
        newValue: '/tmp/reopened',
      }),
    )
    expect(() =>
      composeWorkflowWithCursor(
        'ship',
        'fixture',
        'default',
        { ...reopenedArgs, branch: 'DEV-822-other' },
        context,
        d,
      ),
    ).toThrow('workflow argument "branch" conflicts with the cursor')
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
      closeStep('ship', 'fixture', 'default', args, `closed ${step.slug}`, context, d)

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

    expect(closeStep('ship', 'fixture', 'default', args, 'rebased', context, d)).toContain(
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
      output = closeStep('ship', 'fixture', 'default', args, `closed ${step.slug}`, context, d)
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
      output = closeStep(
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
    awaitWorkflowRuling('ship', 'fixture', 'default', args, 'Which ruling?', context, d, () => {})
    expect(d.query('SELECT state,question FROM workflow_cursor').get()).toEqual({
      state: 'awaiting-ruling',
      question: 'Which ruling?',
    })
    expect(
      d.query('SELECT workflow_key,asked_via,question,answered_at,closed_at FROM question').get(),
    ).toEqual({
      workflow_key: 'DEV-822',
      asked_via: 'workflow',
      question: 'Which ruling?',
      answered_at: null,
      closed_at: null,
    })

    getWorkflowStepWithCursor('ship', 'fixture', 'rebase', args, 'default', context, d)
    expect(d.query('SELECT state,question FROM workflow_cursor').get()).toEqual({
      state: 'running',
      question: null,
    })
    expect(d.query('SELECT close_reason FROM question').get()).toEqual({
      close_reason: 'advanced-without-ruling',
    })
  })

  test('re-ask is idempotent and rule records the answer before resuming the same step', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    const first = awaitWorkflowRuling(
      'ship',
      'fixture',
      'default',
      args,
      'First?',
      context,
      d,
      () => {},
    )
    const updated = awaitWorkflowRuling(
      'ship',
      'fixture',
      'default',
      args,
      'Updated?',
      context,
      d,
      () => {},
    )
    expect(first.questionId).toBe(1)
    expect(updated.questionId).toBe(1)
    expect(d.query('SELECT count(*) count FROM question').get()).toEqual({ count: 1 })

    expect(
      ruleWorkflow('ship', 'fixture', 'default', args, 'Proceed.', true, 'mcp', context, d),
    ).toMatchObject({ questionId: 1 })
    expect(d.query('SELECT state,ordinal,step_slug FROM workflow_cursor').get()).toEqual({
      state: 'running',
      ordinal: 0,
      step_slug: 'rebase',
    })
    expect(
      d.query('SELECT question,answer,answerer_kind,answer_channel FROM question').get(),
    ).toEqual({
      question: 'Updated?',
      answer: 'Proceed.',
      answerer_kind: 'operator',
      answer_channel: 'mcp',
    })
    expect(d.query('SELECT action FROM question_mutation_audit').get()).toEqual({ action: 'rule' })
    expect(() =>
      ruleWorkflow('ship', 'fixture', 'default', args, 'Again', true, 'cli', context, d),
    ).toThrow('is not awaiting a ruling')
  })

  test('workflow rule requires owner authority or operator override and audits the actual actor', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    awaitWorkflowRuling('ship', 'fixture', 'default', args, 'Proceed?', context, d, () => {})
    const prior = process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_SESSION_ID = 'foreign-session'
    try {
      expect(() =>
        ruleWorkflow('ship', 'fixture', 'default', args, 'Proceed.', false, 'cli', context, d),
      ).toThrow('owned by session session-one')
      ruleWorkflow('ship', 'fixture', 'default', args, 'Proceed.', true, 'cli', context, d)
      expect(d.query('SELECT action,actor_session FROM question_mutation_audit').all()).toEqual([
        { action: 'rule', actor_session: 'foreign-session' },
      ])
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = prior
    }
  })

  test('workflow rule refuses a session-less caller even when the owner is gone', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    awaitWorkflowRuling('ship', 'fixture', 'default', args, 'Proceed?', context, d, () => {})
    d.query('UPDATE workflow_cursor SET updated_at=?').run('2020-01-01T00:00:00.000Z')
    const prior = process.env.CLAUDE_CODE_SESSION_ID
    delete process.env.CLAUDE_CODE_SESSION_ID
    try {
      expect(() =>
        ruleWorkflow('ship', 'fixture', 'default', args, 'Proceed.', false, 'cli', context, d),
      ).toThrow('CLAUDE_CODE_SESSION_ID is not set')
      expect(d.query('SELECT answer FROM question').get()).toEqual({ answer: null })
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = prior
    }
  })

  test("an adopted workflow rule keeps the gone owner's session", () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    awaitWorkflowRuling('ship', 'fixture', 'default', args, 'Proceed?', context, d, () => {})
    d.query('UPDATE workflow_cursor SET updated_at=?').run('2020-01-01T00:00:00.000Z')
    const prior = process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_SESSION_ID = 'adopting-session'
    try {
      ruleWorkflow('ship', 'fixture', 'default', args, 'Proceed.', false, 'cli', context, d)
      expect(d.query('SELECT session_id FROM workflow_cursor').get()).toEqual({
        session_id: 'session-one',
      })
      expect(d.query('SELECT reason FROM question_mutation_audit').get()).toEqual({
        reason: 'adopted from gone owner session-one by adopting-session; Proceed.',
      })
    } finally {
      if (prior === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
      else process.env.CLAUDE_CODE_SESSION_ID = prior
    }
  })

  test('await persists a rebound argument while refusing other conflicts', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)

    const reopenedArgs = { ...args, worktree: '/tmp/reopened' }
    awaitWorkflowRuling('ship', 'fixture', 'default', reopenedArgs, 'Which ruling?', context, d)

    const row = d.query('SELECT state,args,closed FROM workflow_cursor').get() as {
      state: string
      args: string
      closed: string
    }
    expect(row.state).toBe('awaiting-ruling')
    expect(JSON.parse(row.args).worktree).toBe('/tmp/reopened')
    expect(JSON.parse(row.closed)).toContainEqual(
      expect.objectContaining({ event: 'argument-rebound', name: 'worktree' }),
    )
    expect(() =>
      awaitWorkflowRuling(
        'ship',
        'fixture',
        'default',
        { ...reopenedArgs, branch: 'DEV-822-other' },
        'Another ruling?',
        context,
        d,
      ),
    ).toThrow('workflow argument "branch" conflicts with the cursor')
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
    expect(() => closeStep('ship', 'fixture', 'default', args, 'continue', context, d)).toThrow(
      'workflow ship for DEV-822 is abandoned',
    )
    expect(() =>
      awaitWorkflowRuling('ship', 'fixture', 'default', args, 'Question?', context, d, () => {}),
    ).toThrow('workflow ship for DEV-822 is abandoned')
    expect(() =>
      abandonWorkflowCursor('ship', 'fixture', 'default', args, 'again', context, d),
    ).toThrow('workflow ship for DEV-822 is abandoned')
  })

  test('abandon clears an awaiting cursor question and records the current session', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    awaitWorkflowRuling('ship', 'fixture', 'default', args, 'Which ruling?', context, d, () => {})

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
    expect(d.query('SELECT close_reason FROM question').get()).toEqual({
      close_reason: 'abandoned',
    })
  })

  test('abandon dispositions open obligations in the same transaction', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    const cursor = d.query<{ id: number }, []>('SELECT id FROM workflow_cursor').get() as {
      id: number
    }
    d.query(
      `INSERT INTO workflow_obligation
        (cursor_id,step_ordinal,step_slug,floor,floor_deferrable,reason,session_id,created_at)
       VALUES (?,1,'rebase','command-exit',1,'merge later','session-one','2026-09-01')`,
    ).run(cursor.id)
    abandonWorkflowCursor('ship', 'fixture', 'default', args, 'operator stopped', context, d)
    expect(
      d
        .query(
          'SELECT abandoned_reason, abandoned_at IS NOT NULL AS stamped FROM workflow_obligation',
        )
        .get(),
    ).toEqual({ abandoned_reason: 'operator stopped', stamped: 1 })
    expect(
      d
        .query(
          `SELECT count(*) count FROM workflow_obligation
            WHERE cursor_id=? AND satisfied_at IS NULL AND abandoned_at IS NULL`,
        )
        .get(cursor.id),
    ).toEqual({ count: 0 })
  })

  test('abandon requires a non-blank reason and refuses done cursors', () => {
    const d = database()
    const composition = composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    expect(() =>
      abandonWorkflowCursor('ship', 'fixture', 'default', args, '   ', context, d),
    ).toThrow('--reason is required')
    for (const step of composition.steps)
      closeStep('ship', 'fixture', 'default', args, `closed ${step.slug}`, context, d)
    expect(() =>
      abandonWorkflowCursor('ship', 'fixture', 'default', args, 'too late', context, d),
    ).toThrow('workflow ship for DEV-822 is done')
  })

  test('an advanced cursor keeps its pinned versions and args when production moves on', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    getWorkflowStepWithCursor('ship', 'fixture', 'rebase', args, 'default', context, d)
    closeStep('ship', 'fixture', 'default', args, 'rebased', context, d)
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
    expect(recomposed.arguments.worktree).toBe('/tmp/other')
    expect(recomposed.steps.map((step) => step.slug).slice(0, 2)).toEqual(['rebase', 'lens'])
    expect(d.query('SELECT count(*) count FROM workflow_cursor').get()).toEqual({ count: 1 })
    expect(closeStep('ship', 'fixture', 'default', args, 'lensed', context, d)).toContain(
      'serves step 4',
    )
  })

  test('a second session takes a keyed cursor over and is told so', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    getWorkflowStepWithCursor('ship', 'fixture', 'rebase', args, 'default', context, d)
    closeStep('ship', 'fixture', 'default', args, 'rebased', context, d)
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
      release: { value: 'land' as const, scope: 'built-in' },
      session: { steps: { rebase: 'review' as const }, release: 'promote' as const },
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
    const snapshot = JSON.parse(
      (d.query('SELECT autonomy FROM workflow_cursor').get() as { autonomy: string }).autonomy,
    ) as { session: Record<string, unknown> }
    expect(snapshot.session.release).toBeUndefined()
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
      message = closeStep('ship', 'fixture', 'default', args, `closed ${step.slug}`, context, d)
    }
    expect(message).toContain('For your review: 1. rebase — closed rebase')
  })

  test('floors enforcement refuses a note-only close and names the flag', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    expect(() =>
      nextWorkflowStep('ship', 'fixture', 'default', args, 'rebased', context, d),
    ).toThrow(/floor command-exit is unmet; pass --gate/)
  })

  test('a pre-change cursor keeps note-only closure', () => {
    const d = database()
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d)
    d.query("UPDATE workflow_cursor SET enforcement='note-only'").run()
    expect(nextWorkflowStep('ship', 'fixture', 'default', args, 'rebased', context, d)).toContain(
      'serves step 3 score',
    )
  })

  test('a null pre-migration snapshot falls back to catalogue defaults', () => {
    const d = database()
    const resolution = {
      steps: { rebase: { value: 'review' as const, scope: 'session' } },
      rulings: { value: 'agent' as const, scope: 'built-in' },
      release: { value: 'land' as const, scope: 'built-in' },
    }
    composeWorkflowWithCursor('ship', 'fixture', 'default', args, context, d, {}, resolution)
    d.query('UPDATE workflow_cursor SET autonomy=NULL').run()
    getWorkflowStepWithCursor('ship', 'fixture', 'rebase', args, 'default', context, d)
    closeStep('ship', 'fixture', 'default', args, 'rebased', context, d)
    const row = d.query('SELECT closed FROM workflow_cursor').get() as { closed: string }
    expect(JSON.parse(row.closed)[0].review).toBeUndefined()
  })
})
