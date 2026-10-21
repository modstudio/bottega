import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from '../database/migrations.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import { composeWorkflowWithCursor, nextWorkflowStep } from './workflow-cursor.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { installWorkflowStoreFixture } from './workflow-store.fixture.ts'

const args = { key: 'DEV-822', branch: 'DEV-822-work', worktree: '/tmp/work' }
const context = { session: 'session-one' }

function database(): Database {
  const d = new Database(':memory:')
  d.exec('PRAGMA foreign_keys=ON')
  applyMigrations(d)
  seedWorkflows(d)
  installWorkflowStoreFixture(d)
  d.query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)').run(
    newRecordId(),
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
  const current = productionStepCatalogue(d).definition
  const draft = setStepCatalogueLocal(
    {
      ...current,
      steps: current.steps.map((step) =>
        step.slug === 'pr' ? { ...step, commandEvidence: 'pull-request' as const } : step,
      ),
    },
    'pull-request evidence fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(draft.n, 'publish pull-request evidence fixture', 'test', d)
  return d
}

test('open-pr does not advance from a review-lens run artifact', () => {
  const d = database()
  const composition = composeWorkflowWithCursor('flow', 'fixture', 'default', args, context, d)
  const ordinal = composition.steps.findIndex((step) => step.slug === 'pr')
  expect(ordinal).toBeGreaterThanOrEqual(0)
  d.query("UPDATE workflow_cursor SET ordinal=?,step_slug='pr',closed=?").run(
    ordinal,
    JSON.stringify([
      {
        n: ordinal,
        slug: composition.steps[ordinal - 1]!.slug,
        note: 'prior step closed',
        at: '2026-09-01',
      },
    ]),
  )
  const projectId = (
    d.query("SELECT record_id FROM project WHERE name='fixture'").get() as { record_id: string }
  ).record_id
  const run = d
    .query<{ number: number }, (string | number)[]>(
      `INSERT INTO run
        (record_id,number,started_at,agent,job,repo,project_record_id,prompt_sha,prompt_bytes,prompt_head,
         status,exit_code,launch_key,branch)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,?,?,?,?,?,?,?,?,?,?,?) RETURNING number`,
    )
    .get(
      newRecordId(),
      new Date().toISOString(),
      'codex',
      'review-lens',
      'fixture',
      projectId,
      'sha',
      1,
      'review',
      'ok',
      0,
      args.key,
      args.branch,
    )!

  expect(() =>
    nextWorkflowStep(
      'flow',
      'fixture',
      'default',
      args,
      'opened pull request',
      context,
      d,
      { artifact: String(run.number) },
      { runHasArtifacts: () => true, resolveTreeCommit: () => 'abc' },
    ),
  ).toThrow('floor recorded-artifact is unmet')
  expect(d.query('SELECT ordinal,step_slug FROM workflow_cursor').get()).toEqual({
    ordinal,
    step_slug: 'pr',
  })
})
