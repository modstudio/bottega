import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import type { AutonomyResolution } from './autonomy.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import {
  composeWorkflowWithCursor,
  getWorkflowStepWithCursor,
  nextWorkflowStep,
} from './workflow-cursor.ts'
import { resolveWorkflowLiveAutonomy } from './workflow-cursor-live-autonomy.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { installWorkflowStoreFixture } from './workflow-store.fixture.ts'
import { composeWorkflow } from './workflows.ts'

const args = {
  key: 'DEV-1264',
  branch: 'DEV-1264-work',
  worktree: '/tmp/work',
}
const context = { session: 'session-one' }
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
    steps: Object.fromEntries(
      preliminary.steps.map((step) => [step.slug, { value: 'auto' as const, scope: 'test' }]),
    ),
    rulings: { value: 'agent' as const, scope: 'test' },
    shipTo: { value: 'trunk' as const, scope: 'test' },
  }
}

function openAtRuling(d: Database): void {
  composeWorkflowWithCursor(
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
    nextWorkflowStep(
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

function selfRule(d: Database, question?: string): string {
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

test('self-ruling records the answered question and closes the step atomically', () => {
  const d = database()
  openAtRuling(d)
  const result = selfRule(d)
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
                answerer_kind,answer_channel,answered_by
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
    count: 1,
  })
})

test('a close failure rolls back the self-ruling question and audit', () => {
  const d = database()
  openAtRuling(d)
  d.exec(`CREATE TRIGGER fail_self_ruling_close BEFORE UPDATE ON workflow_cursor
    WHEN OLD.step_slug='ship-triage' AND NEW.step_slug='complete'
    BEGIN SELECT RAISE(ABORT, 'injected close failure'); END`)
  expect(() => selfRule(d)).toThrow('injected close failure')
  expect(d.query('SELECT ordinal,step_slug FROM workflow_cursor').get()).toEqual({
    ordinal: 3,
    step_slug: 'ship-triage',
  })
  expect(d.query('SELECT count(*) count FROM question').get()).toEqual({
    count: 0,
  })
  expect(d.query('SELECT count(*) count FROM question_mutation_audit').get()).toEqual({ count: 0 })
})

test('self-ruling refuses ask autonomy without changing the cursor or questions', () => {
  const d = database()
  const automatic = resolution(d)
  const resolved = {
    ...automatic,
    steps: {
      ...automatic.steps,
      'ship-triage': { value: 'ask' as const, scope: 'test' },
    },
  }
  composeWorkflowWithCursor(
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
    nextWorkflowStep(
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
  expect(() => selfRule(d)).toThrow(/resolved autonomy is ask.*workflow await.*workflow rule/)
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
  openAtRuling(d)
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
    getWorkflowStepWithCursor('flow', 'fixture', 'ship-triage', args, 'default', context, d, live)
      .resolvedAutonomy,
  ).toEqual({ value: 'ask', scope: 'project' })
  expect(() =>
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
  ).toThrow(/resolved autonomy is ask.*workflow await.*workflow rule/)
})

test('self-ruling refuses a non-ruling step without changing the cursor or questions', () => {
  const d = database()
  composeWorkflowWithCursor(
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
  expect(() => selfRule(d)).toThrow(/has no ruling floor.*evidence its floor names/)
  expect(d.query('SELECT ordinal,step_slug,state FROM workflow_cursor').get()).toEqual(cursorBefore)
  expect(d.query('SELECT count(*) count FROM question').get()).toEqual({
    count: 0,
  })
})

test('self-ruling refuses an operator-ruling floor without changing durable state', () => {
  const d = database()
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogueLocal(
    {
      ...current,
      steps: current.steps.map((step) =>
        step.slug === 'ship-triage' ? { ...step, operatorRuling: true } : step,
      ),
    },
    'operator-ruling fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(catalogue.n, 'publish operator-ruling fixture', 'test', d)
  openAtRuling(d)
  expect(() => selfRule(d)).toThrow(/requires an operator ruling.*--from-operator/)
  expect(d.query('SELECT ordinal,step_slug FROM workflow_cursor').get()).toEqual({
    ordinal: 3,
    step_slug: 'ship-triage',
  })
  expect(d.query('SELECT count(*) count FROM question').get()).toEqual({
    count: 0,
  })
})
