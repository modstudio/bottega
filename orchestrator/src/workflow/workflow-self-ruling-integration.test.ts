import type { Database } from 'bun:sqlite'
import { expect, spyOn, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import * as taskFlowWriter from '../record/record-task-flow-write-client.ts'
import type { AutonomyResolution } from './autonomy.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import { workflowNextContextMoment } from './workflow-context-moment.ts'
import { awaitWorkflowRuling, composeWorkflowWithCursor } from './workflow-cursor.ts'
import { resolveWorkflowLiveAutonomy } from './workflow-cursor-live-autonomy.ts'
import { getWorkflowStepWithCursor } from './workflow-cursor-serve.ts'
import { selectAndNextWorkflowStep as nextWorkflowStep } from './workflow-cursor-test.fixture.ts'
import { flagForFloor } from './workflow-floor.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { installWorkflowStoreFixture } from './workflow-store.fixture.ts'
import { closeCursorWithTextCopy, closeCursorWithTextCopyResult } from './workflow-text-copy.ts'
import { composeWorkflow } from './workflows.ts'

const args = {
  key: 'DEV-1264',
  branch: 'DEV-1264-work',
  worktree: '/tmp/work',
}
const context = { session: 'session-one', taskRecordId: 'task-DEV-1264' }
const ports = {
  resolveCheckout: () => ({
    project: 'fixture',
    branch: args.branch,
    checkoutPath: args.worktree,
    headIsTipOrAncestor: true,
    landingBranch: 'main',
  }),
  resolveTreeCommit: () => 'abc',
}

const database = testDatabaseFixture((d) => {
  seedWorkflows(d)
  installWorkflowStoreFixture(d)
  d.query(
    'INSERT INTO project (record_id,name,path,stack,settings) VALUES (lower(hex(randomblob(4))) || char(45) || lower(hex(randomblob(2))) || char(45,55) || substr(lower(hex(randomblob(2))),2) || char(45,56) || substr(lower(hex(randomblob(2))),2) || char(45) || lower(hex(randomblob(6))),?,?,?,?)',
  ).run(
    'fixture',
    '/fixture',
    'bun',
    JSON.stringify({
      gate: 'bun run check',
      trunk: 'main',
      docs: { protocol: 'orch-docs' },
      tracker: { protocol: 'hub' },
    }),
  )
})

function resolution(d: Database): AutonomyResolution {
  const preliminary = composeWorkflow('flow', 'fixture', 'default', args, d)
  return {
    layers: [],
    steps: Object.fromEntries(
      preliminary.steps.map((step) => [step.slug, { value: 'auto' as const, scope: 'test' }]),
    ),
    rulings: { value: 'agent' as const, scope: 'test' },
    shipTo: { value: 'trunk' as const, scope: 'test' },
  }
}

async function openAtRuling(d: Database): Promise<void> {
  await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    { resolution: resolution(d) },
  )
  for (const note of ['rebase', 'lens', 'score']) {
    await nextWorkflowStep(
      'flow',
      'fixture',
      'default',
      args,
      note,
      context,
      d,
      { artifact: `probe:${installProbe(d)}` },
      ports,
    )
  }
}

function installProbe(d: Database): number {
  return (
    d
      .query<{ number: number }, []>(
        `INSERT INTO probe (record_id,number,command,cwd,head_commit,exit_code,output_tail,created_at)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM probe),'["true"]','/tmp/work','abc',0,'','2026-10-12') RETURNING number`,
      )
      .get() as { number: number }
  ).number
}

function selfRule(d: Database, question?: string): Promise<string> {
  return nextWorkflowStep(
    'flow',
    'fixture',
    'default',
    args,
    'agent ruled proceed',
    context,
    d,
    {},
    ports,
    undefined,
    {
      ruling: 'Proceed.',
      basis: 'specification line 4',
      question,
      channel: 'mcp',
    },
  )
}

test('self-ruling records the answered question and closes the step atomically', async () => {
  const d = database()
  await openAtRuling(d)
  const result = await selfRule(d)
  expect(result).toContain('Complete the review.')
  expect(result).toContain('Self-ruling: Proceed.\nBasis: specification line 4')
  expect(d.query('SELECT ordinal,step_slug,state FROM workflow_cursor').get()).toEqual({
    ordinal: 4,
    step_slug: 'complete',
    state: 'running',
  })
  expect(
    d
      .query(
        `SELECT workflow_cursor_record_id,workflow_step_ordinal,workflow_step_slug,question,answer,answer_basis,
                answerer_kind,answer_channel,answered_by,answered_by_name
           FROM question`,
      )
      .get(),
  ).toEqual({
    workflow_cursor_record_id: (
      d.query('SELECT record_id FROM workflow_cursor').get() as {
        record_id: string
      }
    ).record_id,
    workflow_step_ordinal: 4,
    workflow_step_slug: 'ship-triage',
    question: 'Triage every finding',
    answer: 'Proceed.',
    answer_basis: 'specification line 4',
    answerer_kind: 'agent',
    answer_channel: 'mcp',
    answered_by: expect.stringMatching(/^operator:/),
    answered_by_name: null,
  })
  expect(d.query('SELECT action,actor_session,reason FROM question_mutation_audit').get()).toEqual({
    action: 'rule',
    actor_session: expect.stringMatching(/^operator:/),
    reason: 'Proceed.',
  })
  const times = d.query('SELECT asked_at,answered_at FROM question').get() as {
    asked_at: string
    answered_at: string
  }
  expect(times.answered_at).toBe(times.asked_at)
  expect(d.query("SELECT count(*) count FROM outbox WHERE kind='question'").get()).toEqual({
    count: 0,
  })
})

test('a failed self-ruling write does not advance a running cursor', async () => {
  const d = database()
  await openAtRuling(d)
  const before = d.query('SELECT ordinal,step_slug,state,revision FROM workflow_cursor').get()
  d.exec(`CREATE TRIGGER fail_dev2394_self_ruling_insert BEFORE INSERT ON question
    BEGIN SELECT RAISE(ABORT,'injected self-ruling write failure'); END`)
  const write = spyOn(taskFlowWriter, 'writeHostedTaskFlow')
  write.mockClear()

  await expect(selfRule(d)).rejects.toThrow('injected self-ruling write failure')

  expect(write).not.toHaveBeenCalled()
  expect(d.query('SELECT ordinal,step_slug,state,revision FROM workflow_cursor').get()).toEqual(
    before,
  )
  expect(d.query('SELECT count(*) count FROM question').get()).toEqual({ count: 0 })
  write.mockRestore()
})

test('a failed self-ruling write leaves an awaiting cursor and its question open', async () => {
  const d = database()
  await openAtRuling(d)
  await awaitWorkflowRuling('flow', 'fixture', 'default', args, 'Proceed?', context, d, () => {})
  const before = d.query('SELECT ordinal,step_slug,state,revision FROM workflow_cursor').get()
  d.exec(`CREATE TRIGGER fail_dev2394_self_ruling_answer BEFORE UPDATE OF answer ON question
    WHEN NEW.answer IS NOT NULL
    BEGIN SELECT RAISE(ABORT,'injected self-ruling write failure'); END`)
  const write = spyOn(taskFlowWriter, 'writeHostedTaskFlow')
  write.mockClear()

  await expect(selfRule(d)).rejects.toThrow('injected self-ruling write failure')

  expect(write).not.toHaveBeenCalled()
  expect(d.query('SELECT ordinal,step_slug,state,revision FROM workflow_cursor').get()).toEqual(
    before,
  )
  expect(d.query('SELECT answered_at,closed_at FROM question').get()).toEqual({
    answered_at: null,
    closed_at: null,
  })
  write.mockRestore()
})

test('a hosted advance failure on an awaiting cursor does not close its question', async () => {
  const d = database()
  await openAtRuling(d)
  await awaitWorkflowRuling('flow', 'fixture', 'default', args, 'Proceed?', context, d, () => {})
  const before = d.query('SELECT ordinal,step_slug,state,revision FROM workflow_cursor').get()
  const write = spyOn(taskFlowWriter, 'writeHostedTaskFlow')
  write.mockImplementation(() => Promise.reject(new Error('injected hosted advance failure')))

  try {
    await expect(selfRule(d)).rejects.toThrow('injected hosted advance failure')
  } finally {
    write.mockRestore()
  }

  expect(d.query('SELECT ordinal,step_slug,state,revision FROM workflow_cursor').get()).toEqual(
    before,
  )
  expect(d.query('SELECT answered_at,closed_at FROM question').get()).toEqual({
    answered_at: expect.any(String),
    closed_at: null,
  })
})

test('a failed workflow-question write does not write an await-ruling advance', async () => {
  const d = database()
  await openAtRuling(d)
  const before = d.query('SELECT ordinal,step_slug,state,revision FROM workflow_cursor').get()
  d.exec(`CREATE TRIGGER fail_dev2394_await_question BEFORE INSERT ON question
    BEGIN SELECT RAISE(ABORT,'injected workflow-question write failure'); END`)
  const write = spyOn(taskFlowWriter, 'writeHostedTaskFlow')
  write.mockClear()

  await expect(
    awaitWorkflowRuling('flow', 'fixture', 'default', args, 'Proceed?', context, d, () => {}),
  ).rejects.toThrow('injected workflow-question write failure')

  expect(write).not.toHaveBeenCalled()
  expect(d.query('SELECT ordinal,step_slug,state,revision FROM workflow_cursor').get()).toEqual(
    before,
  )
  write.mockRestore()
})

test('review-owed is applied as the only floor and leaves no evidence floor behind', async () => {
  const d = database()
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogueLocal(
    {
      ...current,
      steps: current.steps.map((step) =>
        step.slug === 'rebase' ? { ...step, floor: ['review-owed' as const] } : step,
      ),
    },
    'review-owed floor fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(catalogue.n, 'publish review-owed floor fixture', 'test', d)
  await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    { resolution: resolution(d) },
  )

  let allow = false
  let calls = 0
  const floorPorts = {
    ...ports,
    reviewOwed: () => {
      calls += 1
      return allow
        ? ({ action: 'allow' } as const)
        : ({ action: 'refuse', message: 'review lens is still running' } as const)
    },
  }
  const input = {
    action: 'next' as const,
    project: 'fixture',
    workflow: 'flow',
    mode: 'default',
    key: args.key,
    args,
    context,
    note: 'reviewed the change',
    evidence: {},
    floorPorts,
  }

  await expect(closeCursorWithTextCopyResult(input, d)).rejects.toThrow(
    'review lens is still running',
  )
  expect(calls).toBe(1)
  expect(d.query('SELECT ordinal,step_slug FROM workflow_cursor').get()).toEqual({
    ordinal: 0,
    step_slug: 'rebase',
  })

  allow = true
  await closeCursorWithTextCopyResult(input, d)
  expect(calls).toBe(2)
  expect(d.query('SELECT ordinal,step_slug FROM workflow_cursor').get()).toEqual({
    ordinal: 1,
    step_slug: 'lens',
  })
})

test('a whitespace-padded self-ruling carries its question into the context moment', async () => {
  const d = database()
  await openAtRuling(d)
  const result = await closeCursorWithTextCopyResult(
    {
      action: 'next',
      project: 'fixture',
      workflow: 'flow',
      mode: 'default',
      key: 'DEV-1264',
      args,
      context,
      note: 'agent ruled proceed',
      evidence: {},
      floorPorts: ports,
      selfRuling: {
        ruling: '  Proceed.  ',
        basis: 'specification line 4',
        channel: 'cli',
      },
    },
    d,
  )

  expect(result.selfRulingQuestionNumber).toBeNumber()
  expect(
    workflowNextContextMoment(
      {
        workflowKey: result.workflowKey,
        cursorRecordId: result.cursorRecordId,
      },
      result.selfRulingQuestionNumber,
      'Proceed.',
    ).effect.writes,
  ).toContainEqual(
    expect.objectContaining({
      holder: { kind: 'task', value: 'DEV-1264' },
      kind: 'position',
      id: `position-q${result.selfRulingQuestionNumber}`,
      source: `q${result.selfRulingQuestionNumber}`,
      body: 'Proceed.',
    }),
  )
  expect(d.query<{ answer: string }, []>('SELECT answer FROM question').get()).toEqual({
    answer: 'Proceed.',
  })
})

test('misspelled self-ruling is refused before recording or advancing', async () => {
  const d = database()
  await openAtRuling(d)
  const cursorBefore = d.query('SELECT ordinal,step_slug,state FROM workflow_cursor').get()
  const misspelling = ['me', 'ida'].join('')
  await expect(
    closeCursorWithTextCopy(
      {
        action: 'next',
        project: 'fixture',
        workflow: 'flow',
        mode: 'default',
        key: 'DEV-1264',
        args,
        context,
        note: 'agent ruled proceed',
        evidence: {},
        floorPorts: ports,
        selfRuling: {
          ruling: `We saw the ${misspelling} here.`,
          basis: 'The specification permits this action.',
          channel: 'mcp',
        },
      },
      d,
    ),
  ).rejects.toThrow(`self-ruling text:\n"${misspelling}"`)
  expect(d.query('SELECT ordinal,step_slug,state FROM workflow_cursor').get()).toEqual(cursorBefore)
  expect(d.query('SELECT count(*) count FROM question').get()).toEqual({ count: 0 })
})

test('a close failure rolls back the self-ruling question and audit', async () => {
  const d = database()
  await openAtRuling(d)
  d.exec(`CREATE TRIGGER fail_self_ruling_close BEFORE UPDATE ON workflow_cursor
    WHEN OLD.step_slug='ship-triage' AND NEW.step_slug='complete'
    BEGIN SELECT RAISE(ABORT, 'injected close failure'); END`)
  await expect(selfRule(d)).rejects.toThrow('injected close failure')
  expect(d.query('SELECT ordinal,step_slug FROM workflow_cursor').get()).toEqual({
    ordinal: 3,
    step_slug: 'ship-triage',
  })
  expect(d.query('SELECT count(*) count FROM question').get()).toEqual({
    count: 0,
  })
  expect(d.query('SELECT count(*) count FROM question_mutation_audit').get()).toEqual({ count: 0 })
})

test('self-ruling refuses ask autonomy without changing the cursor or questions', async () => {
  const d = database()
  const automatic = resolution(d)
  const resolved = {
    ...automatic,
    steps: {
      ...automatic.steps,
      'ship-triage': { value: 'ask' as const, scope: 'test' },
    },
  }
  await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    { resolution: resolved },
  )
  for (const note of ['rebase', 'lens', 'score']) {
    await nextWorkflowStep(
      'flow',
      'fixture',
      'default',
      args,
      note,
      context,
      d,
      { artifact: `probe:${installProbe(d)}` },
      ports,
    )
  }
  await expect(selfRule(d)).rejects.toThrow(
    /resolved autonomy is ask.*workflow await.*workflow rule/,
  )
  expect(d.query('SELECT ordinal,step_slug FROM workflow_cursor').get()).toEqual({
    ordinal: 3,
    step_slug: 'ship-triage',
  })
  expect(d.query('SELECT count(*) count FROM question').get()).toEqual({
    count: 0,
  })
})

test('a resolved live ask setting tightens a real cursor and refuses its self-ruling', async () => {
  const d = database()
  await openAtRuling(d)
  d.query('UPDATE project SET settings=? WHERE name=?').run(
    JSON.stringify({
      gate: 'bun run check',
      trunk: 'main',
      docs: { protocol: 'orch-docs' },
      tracker: { protocol: 'hub' },
      autonomy: { steps: { 'ship-triage': 'ask' } },
    }),
    'fixture',
  )
  const live = await resolveWorkflowLiveAutonomy(
    { slug: 'flow', project: 'fixture', mode: 'default', args, context },
    d,
  )

  expect(
    (
      await getWorkflowStepWithCursor(
        'flow',
        'fixture',
        'ship-triage',
        args,
        'default',
        context,
        d,
        live,
      )
    ).resolvedAutonomy,
  ).toEqual({ value: 'ask', scope: 'project' })
  await expect(
    nextWorkflowStep(
      'flow',
      'fixture',
      'default',
      args,
      'agent ruled proceed',
      context,
      d,
      {},
      ports,
      undefined,
      { ruling: 'Proceed.', basis: 'specification line 4', channel: 'mcp' },
      undefined,
      live,
    ),
  ).rejects.toThrow(/resolved autonomy is ask.*workflow await.*workflow rule/)
})

test('self-ruling refuses a non-ruling step without changing the cursor or questions', async () => {
  const d = database()
  await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    { resolution: resolution(d) },
  )
  const cursorBefore = d.query('SELECT ordinal,step_slug,state FROM workflow_cursor').get()
  await expect(selfRule(d)).rejects.toThrow(
    `self-ruling is refused because step 1 rebase has no ruling floor; close it with ${flagForFloor('command-exit')}`,
  )
  expect(d.query('SELECT ordinal,step_slug,state FROM workflow_cursor').get()).toEqual(cursorBefore)
  expect(d.query('SELECT count(*) count FROM question').get()).toEqual({
    count: 0,
  })
})

test("self-ruling refuses a person's-ruling floor without changing durable state", async () => {
  const d = database()
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogueLocal(
    {
      ...current,
      steps: current.steps.map((step) =>
        step.slug === 'ship-triage' ? { ...step, operatorRuling: true } : step,
      ),
    },
    "person's-ruling fixture",
    'test',
    d,
  )
  promoteStepCatalogueLocal(catalogue.n, "publish person's-ruling fixture", 'test', d)
  await openAtRuling(d)
  await expect(selfRule(d)).rejects.toThrow(/requires a ruling recorded with --from-operator/)
  expect(d.query('SELECT ordinal,step_slug FROM workflow_cursor').get()).toEqual({
    ordinal: 3,
    step_slug: 'ship-triage',
  })
  expect(d.query('SELECT count(*) count FROM question').get()).toEqual({
    count: 0,
  })
})
