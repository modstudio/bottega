import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { productionStepCatalogue } from './step-catalogue.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import {
  bindRecordedRunCursorArguments,
  decideCursorBranchBinding,
} from './workflow-cursor-binding.ts'
import { closeStep, context } from './workflow-cursor-test.fixture.ts'
import { expandWorkflowSteps } from './workflow-step-sequences.ts'
import { seedCurrentWorkflowTreeFixture } from './workflow-store.fixture.ts'
import { getWorkflowStep, showResolvedWorkflow } from './workflows.ts'

const currentDatabase = testDatabaseFixture((d) =>
  seedCurrentWorkflowTreeFixture(d, ['fix-defect'], 'DEV-2449 current workflow fixture'),
)

describe('cursor branch binding decision', () => {
  test.each([
    ['fill', null, null, 'DEV-2449-new', { action: 'fill' }],
    ['no-op', 'DEV-2449-new', null, 'DEV-2449-new', { action: 'no-op' }],
    ['rebind', 'DEV-2449-old', null, 'DEV-2449-new', { action: 'rebind' }],
    ['refuse', 'DEV-2449-old', 2449, 'DEV-2449-new', { action: 'refuse', pullRequestNumber: 2449 }],
  ] as const)('%s', (_label, currentBranch, pullRequestNumber, runBranch, expected) => {
    expect(decideCursorBranchBinding({ currentBranch, pullRequestNumber, runBranch })).toEqual(
      expected,
    )
  })
})

test('a bound implement run makes every fix-defect step render and advances blast-radius', async () => {
  const d = currentDatabase()
  d.query('UPDATE project SET settings=? WHERE name=?').run(
    JSON.stringify({
      gate: 'bun run check',
      trunk: 'main',
      tracker: { protocol: 'hub' },
      docs: { protocol: 'orch-docs' },
      release: { rungs: [], mergeMethod: 'squash', requiredChecks: [] },
    }),
    'fixture',
  )
  const key = 'DEV-2449'
  const guardContext = { session: context.session, taskRecordId: `task-${key}` }
  const branch = 'DEV-2449-orch-guard'
  const worktree = '/tmp/dev-2449-orch-guard'
  const definition = showResolvedWorkflow('fix-defect', undefined, 'fixture', d).definition
  const mode = definition.modes.find(({ slug }) => slug === 'single')!
  const stepSlugs = expandWorkflowSteps(
    mode.steps,
    productionStepCatalogue(d).definition.sequences ?? [],
  )
  const resolution = {
    layers: [],
    steps: Object.fromEntries(
      stepSlugs.map((slug) => [slug, { value: 'auto' as const, scope: 'test' }]),
    ),
    rulings: { value: 'agent' as const, scope: 'test' },
    shipTo: { value: 'trunk' as const, scope: 'test' },
  }
  const composition = await composeWorkflowWithCursor(
    'fix-defect',
    'fixture',
    'single',
    { key },
    guardContext,
    d,
    {},
    { resolution },
  )
  const cursor = d
    .query<{ record_id: string }, [number]>('SELECT record_id FROM workflow_cursor WHERE number=?')
    .get(composition.cursor!.id)!
  const run = newRecordId()
  d.query(
    `INSERT INTO run
      (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,
       cursor_record_id,step_slug,branch,worktree,project_record_id)
     VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-11-18','codex','implement',
             'sha',1,'guard','ok',?,?,?,?,(SELECT record_id FROM project WHERE name='fixture'))`,
  ).run(run, cursor.record_id, 'implement-fix', branch, worktree)

  expect(await bindRecordedRunCursorArguments(run, d)).toEqual({ action: 'updated' })
  const args = JSON.parse(
    (
      d
        .query<{ args: string }, [string]>('SELECT args FROM workflow_cursor WHERE record_id=?')
        .get(cursor.record_id) as { args: string }
    ).args,
  ) as Record<string, string>
  expect(args).toMatchObject({ key, branch, worktree })
  for (const step of composition.steps) {
    expect(() =>
      getWorkflowStep('fix-defect', 'fixture', step.slug, args, d, { mode: 'single' }),
    ).not.toThrow()
  }

  const blastRadius = composition.steps.findIndex((step) => step.slug === 'blast-radius')
  const closed = composition.steps.slice(0, blastRadius).map((step, index) => ({
    n: index + 1,
    slug: step.slug,
    note: 'fixture prerequisite',
    at: '2026-11-18T14:00:00.000Z',
  }))
  d.query('UPDATE workflow_cursor SET ordinal=?,step_slug=?,closed=? WHERE record_id=?').run(
    blastRadius,
    'blast-radius',
    JSON.stringify(closed),
    cursor.record_id,
  )
  const advanced = await closeStep(
    'fix-defect',
    'fixture',
    'single',
    { key },
    'blast radius checked',
    guardContext,
    d,
  )
  expect(
    d.query('SELECT step_slug FROM workflow_cursor WHERE record_id=?').get(cursor.record_id),
  ).toEqual({ step_slug: 'review-lenses' })
  expect(advanced).toContain(branch)
  expect(advanced).not.toContain('unresolved workflow placeholder')

  const renamedBranch = `${branch}-renamed`
  d.query('UPDATE run SET branch=? WHERE record_id=?').run(renamedBranch, run)
  expect(await bindRecordedRunCursorArguments(run, d)).toEqual({ action: 'updated' })
  expect(
    JSON.parse(
      d
        .query<{ closed: string }, [string]>('SELECT closed FROM workflow_cursor WHERE record_id=?')
        .get(cursor.record_id)!.closed,
    ),
  ).toContainEqual(
    expect.objectContaining({
      event: 'argument-rebound',
      name: 'branch',
      oldValue: branch,
      newValue: renamedBranch,
    }),
  )

  d.query(
    `INSERT INTO landing_triage_snapshot
      (record_id,project,project_record_id,branch,tip,tree,pr_number,review_record_ids,patch_id,
       tier,lens_rounds,finding_count,at)
     VALUES (?,'fixture',(SELECT record_id FROM project WHERE name='fixture'),?,'abc','tree',2449,
             '[]','patch',1,1,0,'2026-11-18')`,
  ).run(newRecordId(), renamedBranch)
  const refusedBranch = `${branch}-after-pr`
  const reopenedWorktree = `${worktree}-reopened`
  d.query('UPDATE run SET branch=?,worktree=? WHERE record_id=?').run(
    refusedBranch,
    reopenedWorktree,
    run,
  )
  const refusal = await bindRecordedRunCursorArguments(run, d)
  expect(refusal).toMatchObject({ action: 'refused' })
  if (refusal.action === 'refused') {
    expect(refusal.warning).toContain('pull request #2449')
    expect(refusal.warning).toContain('workflow abandon fix-defect')
  }
  const refusedArgs = JSON.parse(
    d
      .query<{ args: string }, [string]>('SELECT args FROM workflow_cursor WHERE record_id=?')
      .get(cursor.record_id)!.args,
  ) as Record<string, string>
  expect(refusedArgs).toMatchObject({ branch: renamedBranch, worktree: reopenedWorktree })
})

test('a bound read-only run leaves a keyed fix-defect cursor branch and worktree unchanged', async () => {
  const d = currentDatabase()
  d.query('UPDATE project SET settings=? WHERE name=?').run(
    JSON.stringify({
      gate: 'bun run check',
      trunk: 'main',
      tracker: { protocol: 'hub' },
      docs: { protocol: 'orch-docs' },
      release: { rungs: [], mergeMethod: 'squash', requiredChecks: [] },
    }),
    'fixture',
  )
  const key = 'DEV-2449'
  const originalBranch = 'DEV-2449-writer'
  const originalWorktree = '/tmp/dev-2449-writer'
  const definition = showResolvedWorkflow('fix-defect', undefined, 'fixture', d).definition
  const mode = definition.modes.find(({ slug }) => slug === 'single')!
  const stepSlugs = expandWorkflowSteps(
    mode.steps,
    productionStepCatalogue(d).definition.sequences ?? [],
  )
  const composition = await composeWorkflowWithCursor(
    'fix-defect',
    'fixture',
    'single',
    { key, branch: originalBranch, worktree: originalWorktree },
    { session: context.session, taskRecordId: `task-${key}` },
    d,
    {},
    {
      resolution: {
        layers: [],
        steps: Object.fromEntries(
          stepSlugs.map((slug) => [slug, { value: 'auto' as const, scope: 'test' }]),
        ),
        rulings: { value: 'agent', scope: 'test' },
        shipTo: { value: 'trunk', scope: 'test' },
      },
    },
  )
  const cursor = d
    .query<{ record_id: string }, [number]>('SELECT record_id FROM workflow_cursor WHERE number=?')
    .get(composition.cursor!.id)!
  const before = d
    .query<{ args: string; closed: string }, [string]>(
      'SELECT args,closed FROM workflow_cursor WHERE record_id=?',
    )
    .get(cursor.record_id)!
  const run = newRecordId()
  d.query(
    `INSERT INTO run
      (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,
       cursor_record_id,step_slug,branch,worktree,worktree_source,project_record_id)
     VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-11-18','codex','review-lens',
             'sha',1,'readonly guard','ok',?,?,?,?,'readonly_recipe',
             (SELECT record_id FROM project WHERE name='fixture'))`,
  ).run(run, cursor.record_id, 'review-lenses', 'DEV-2449-reader', '/tmp/dev-2449-reader')

  expect(await bindRecordedRunCursorArguments(run, d)).toEqual({ action: 'no-op' })
  expect(
    d.query('SELECT args,closed FROM workflow_cursor WHERE record_id=?').get(cursor.record_id),
  ).toEqual(before)
})
