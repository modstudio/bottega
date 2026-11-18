import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import {
  hostedWorkflowRepositoryFixture,
  installHostedWorkflowTreeFixture,
  publishStaleLocalWorkflowFixture,
  registerCurrentWorkflowProject,
  registerOwningWorkflowProject,
  runWorkflowCommand,
  workflowCommandPresentation,
} from './workflow-store.fixture.ts'
import { setWorkflowLocal } from './workflows.ts'

test('workflow import refuses before writing when the landing branch has no merge base', async () => {
  const fixture = hostedWorkflowRepositoryFixture('import')
  const project = 'import-hosted-worktree'
  registerOwningWorkflowProject(project, fixture.mainCheckout)
  expect(projectAt(fixture.worktree)?.name).toBe(project)
  installHostedWorkflowTreeFixture(project, newRecordId(), fixture.worktree)
  publishStaleLocalWorkflowFixture('import-local-only')
  const lines: string[] = []
  try {
    await expect(
      runWorkflowCommand(
        ['workflow', 'import', '--cwd', fixture.worktree, '--reason', 'unchanged hosted tree'],
        workflowCommandPresentation(lines),
      ),
    ).rejects.toThrow('workflow import refused: no merge base with registered landing branch main')
  } finally {
    fixture.dispose()
  }
  expect(lines).toEqual([])
})

test('workflow promote refuses an unlanded HEAD and records an operator override', async () => {
  registerCurrentWorkflowProject('promotion-admission-project')
  const slug = 'promotion-admission'
  const draft = setWorkflowLocal(
    slug,
    {
      title: 'Promotion admission',
      description: 'Exercises landing-branch promotion admission.',
      arguments: [],
      modes: [],
    },
    'draft for promotion admission',
    'test',
  )
  const argv = [
    'workflow',
    'promote',
    slug,
    String(draft.n),
    '--reason',
    'emergency workflow repair',
  ]
  const options = { promotionContainsHead: () => ({ contains: false }) }
  await expect(runWorkflowCommand(argv, workflowCommandPresentation([]), options)).rejects.toThrow(
    'land the workflow change by pull request',
  )
  await runWorkflowCommand([...argv, '--from-operator'], workflowCommandPresentation([]), options)
  expect(
    db()
      .query<{ author: string; reason: string }, []>(
        `SELECT e.author,e.reason FROM workflow_event e
          JOIN workflow_version v ON v.record_id=e.workflow_version_record_id
          JOIN workflow w ON w.record_id=v.workflow_record_id
          WHERE w.slug='promotion-admission' AND e.event='promote'
          ORDER BY e.at DESC LIMIT 1`,
      )
      .get(),
  ).toEqual({ author: 'Shmuel Barkin', reason: 'emergency workflow repair' })
})
