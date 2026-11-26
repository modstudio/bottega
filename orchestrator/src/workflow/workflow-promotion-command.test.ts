import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startBoundedSync } from '../../../shared/bounded-process.ts'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { scrubbedGitEnv } from '../../../shared/git.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db } from '../database/db.ts'
import { projectAt } from '../project/projects.ts'
import { applyWorkflowCatalogueRow } from '../record/record-cache-workflow.fixture.ts'
import { workflowImportBase } from './workflow-import-branch.ts'
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

const runGit = (cwd: string, args: string[]): string => {
  const result = startBoundedSync(['git', ...args], {
    budget: 'git-plumbing',
    cwd,
    env: scrubbedGitEnv(),
  })
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || `git exited ${result.exitCode}`)
  return result.stdout.trim()
}

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

test('workflow import names the registration and landing-branch remedies separately', () => {
  expect(() => workflowImportBase('/fixture/unregistered', null)).toThrow(
    "no registered project owns this directory; run from a registered project's checkout",
  )
  expect(() =>
    workflowImportBase('/fixture/registered', {
      name: 'fixture-project',
      settings: {},
    } as never),
  ).toThrow(
    `registered project fixture-project has no landing branch in settings.trunk; run ${PLATFORM_SLUG} project set fixture-project --settings '{"trunk":"<branch>"}'`,
  )
})

test('workflow import accepts an intentional older production body only with a since base that includes its change', async () => {
  const fixture = hostedWorkflowRepositoryFixture('intentional-reversion')
  const project = 'intentional-workflow-reversion'
  const path = join(fixture.worktree, '.agents', 'workflows', 'hosted.md')
  const olderBody = '---\ntitle: Hosted fixture\narguments: []\nmodes: []\n---\nHosted fixture.\n'
  const newerBody =
    '---\ntitle: Hosted fixture\narguments: []\nmodes: []\n---\nCurrent production body.\n'
  try {
    runGit(fixture.worktree, ['branch', '-M', 'main'])
    runGit(fixture.worktree, ['add', '.agents/workflows/hosted.md'])
    runGit(fixture.worktree, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--quiet',
      '-m',
      'older workflow body',
    ])
    registerOwningWorkflowProject(project, fixture.worktree)
    const spaceId = newRecordId()
    installHostedWorkflowTreeFixture(project, spaceId, fixture.worktree)

    writeFileSync(path, newerBody)
    runGit(fixture.worktree, ['add', '.agents/workflows/hosted.md'])
    runGit(fixture.worktree, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--quiet',
      '-m',
      'newer workflow body',
    ])
    const beforeReversion = runGit(fixture.worktree, ['rev-parse', 'HEAD'])
    const workflow = db()
      .query<{ record_id: string }, [string]>(
        "SELECT record_id FROM workflow WHERE space_id = ? AND slug = 'hosted'",
      )
      .get(spaceId)!
    db()
      .query(
        "UPDATE workflow_version SET status='retired',retired_at=? WHERE workflow_record_id=? AND status='production'",
      )
      .run('2026-10-21T12:00:00.000Z', workflow.record_id)
    applyWorkflowCatalogueRow(db(), 'workflow_version', {
      id: newRecordId(),
      spaceId,
      ownerId: workflow.record_id,
      n: 2,
      status: 'production',
      definition: JSON.stringify({
        title: 'Hosted fixture',
        description: 'Current production body.',
        arguments: [],
        modes: [],
      }),
      author: 'hosted',
      reason: 'new production body',
      createdAt: '2026-10-21T12:00:00.000Z',
      promotedAt: '2026-10-21T12:00:00.000Z',
      retiredAt: null,
    })

    writeFileSync(path, olderBody)
    runGit(fixture.worktree, ['add', '.agents/workflows/hosted.md'])
    runGit(fixture.worktree, [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--quiet',
      '-m',
      'restore older workflow body',
    ])
    const argv = [
      'workflow',
      'import',
      '--cwd',
      fixture.worktree,
      '--reason',
      'intentional workflow reversion',
    ]
    await expect(runWorkflowCommand(argv, workflowCommandPresentation([]))).rejects.toThrow(
      'refusing stale workflow tree reversion',
    )
    await expect(
      runWorkflowCommand(
        [...argv, '--since', 'missing-since-commit'],
        workflowCommandPresentation([]),
      ),
    ).rejects.toThrow(
      'workflow import refused: --since missing-since-commit must name a commit in this checkout; omit it to measure from the merge base',
    )
    await runWorkflowCommand([...argv, '--since', beforeReversion], workflowCommandPresentation([]))
  } finally {
    fixture.dispose()
  }
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
  const options = {
    promotionContainsHead: () => ({ contains: false }),
    promotionOperatorName: 'Dana Example',
  }
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
  ).toEqual({
    author: 'Dana Example',
    reason: 'override by Dana Example: emergency workflow repair',
  })
})
