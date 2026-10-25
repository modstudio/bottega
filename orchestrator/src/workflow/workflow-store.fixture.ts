import type { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import { scrubbedGitEnv } from '../../../shared/git.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { setRawArgv } from '../commands/support.ts'
import { registerWorkflowCommands } from '../commands/workflow.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { rememberProjectSpace } from '../project-space.ts'
import { applyWorkflowCatalogueRow } from '../record/record-cache-workflow.fixture.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import type { WorkflowCommandOptions, WorkflowPresentation } from './workflow-commands.ts'
import { parseWorkflowTree } from './workflow-tree.ts'
import { collectWorkflowTree } from './workflow-tree-files.ts'
import { promoteWorkflowLocal, setWorkflowLocal, type WorkflowDefinition } from './workflows.ts'

export const workflowCommandPresentation = (lines: string[]) => ({
  log: (line: string) => lines.push(line),
  error: () => {},
  setExitCode: () => {},
})

export const workflowCommandOutcomePresentation = () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCodes: number[] = []
  return {
    stdout,
    stderr,
    exitCodes,
    presentation: {
      log: (line: string) => stdout.push(line),
      error: (line: string) => stderr.push(line),
      setExitCode: (code: number) => exitCodes.push(code),
    },
  }
}

export const workflowRecordedArtifact = (project: string) => {
  const row = db()
    .query<{ record_id: string }, [string, string, string]>(
      `INSERT INTO doc (scope,subject,slug,title,body,delivery,audiences,created_at,updated_at,project_record_id,record_id)
       SELECT 'project', ?, 'floor-artifact', 't', 'b', 'inject', '["technical"]', 't', 't', record_id, ?
         FROM project WHERE name=?
       RETURNING record_id`,
    )
    .get(project, newRecordId(), project) as { record_id: string }
  return [`--artifact`, `doc:${row.record_id}`] as const
}

export async function runWorkflowCommand(
  argv: string[],
  shown: WorkflowPresentation,
  options: WorkflowCommandOptions = {},
): Promise<void> {
  const command = new Command().exitOverride().enablePositionalOptions()
  registerWorkflowCommands(command, shown, options)
  setRawArgv(argv)
  await command.parseAsync(['node', 'orch', ...argv])
}

const registerWorkflowProject = (name: string, path: string) =>
  upsertProject({
    recordId: newRecordId(),
    name,
    path,
    stack: 'bun',
    settings: { gate: 'bun run check', trunk: 'main', docs: { protocol: 'orch-docs' } },
  })

export const registerFixtureWorkflowProject = (name: string) =>
  registerWorkflowProject(name, `/fixture/${name}`)
export const registerCurrentWorkflowProject = (name: string) =>
  registerWorkflowProject(name, process.cwd())
export const registerOwningWorkflowProject = registerWorkflowProject

export function hostedWorkflowRepositoryFixture(label: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `workflow-hosted-${label}-`)))
  const mainCheckout = join(root, 'parent')
  const worktree = join(mainCheckout, 'child')
  mkdirSync(join(worktree, '.agents', 'workflows'), { recursive: true })
  for (const repository of [mainCheckout, worktree]) {
    const initialized = Bun.spawnSync(['git', 'init', '--quiet'], {
      cwd: repository,
      env: scrubbedGitEnv(),
    })
    if (initialized.exitCode !== 0) {
      rmSync(root, { recursive: true, force: true })
      throw new Error(initialized.stderr.toString().trim() || `git init failed in ${repository}`)
    }
  }
  writeFileSync(
    join(worktree, '.agents', 'workflows', 'hosted.md'),
    '---\ntitle: Hosted fixture\narguments: []\nmodes: []\n---\nHosted fixture.\n',
  )
  return {
    mainCheckout,
    worktree,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  }
}

export function publishStaleLocalWorkflowFixture(slug: string) {
  const stale = setWorkflowLocal(
    slug,
    {
      title: 'Stale local workflow',
      description: 'Exists only in the local catalogue.',
      arguments: [],
      modes: [],
    },
    'local stale fixture',
    'test',
  )
  promoteWorkflowLocal(slug, stale.n, 'publish local stale fixture', 'test')
}

export const publishCursorWorkflowFixture = (slug: string, modes: WorkflowDefinition['modes']) => {
  const draft = setWorkflowLocal(
    slug,
    {
      title: `Cursor command ${slug}`,
      description: 'Exercises cursor mode resolution.',
      arguments: [{ name: 'key', required: true, description: 'Task key.' }],
      modes,
    },
    'test cursor mode resolution',
    'test',
  )
  promoteWorkflowLocal(slug, draft.n, 'publish', 'test')
}

export const installHostedWorkflowTreeFixture = (
  project: string,
  spaceId: string,
  repositoryRoot: string,
) => {
  const local = db()
  const tree = parseWorkflowTree(collectWorkflowTree(repositoryRoot))
  const at = '2026-10-20T12:00:00.000Z'
  const catalogueId = newRecordId()
  applyWorkflowCatalogueRow(local, 'step_catalogue', {
    id: catalogueId,
    spaceId,
    slug: 'shared',
    generation: 1,
    createdAt: at,
  })
  applyWorkflowCatalogueRow(local, 'step_catalogue_version', {
    id: newRecordId(),
    spaceId,
    ownerId: catalogueId,
    n: 1,
    status: 'production',
    definition: JSON.stringify({ steps: tree.steps, sequences: tree.sequences }),
    author: 'hosted',
    reason: 'hosted tree fixture',
    createdAt: at,
    promotedAt: at,
    retiredAt: null,
  })
  for (const { slug, definition } of tree.workflows) {
    const workflowId = newRecordId()
    applyWorkflowCatalogueRow(local, 'workflow', {
      id: workflowId,
      spaceId,
      slug,
      generation: 1,
      createdAt: at,
    })
    applyWorkflowCatalogueRow(local, 'workflow_version', {
      id: newRecordId(),
      spaceId,
      ownerId: workflowId,
      n: 1,
      status: 'production',
      definition: JSON.stringify(definition),
      author: 'hosted',
      reason: 'hosted tree fixture',
      createdAt: at,
      promotedAt: at,
      retiredAt: null,
    })
  }
  rememberProjectSpace(local, project, spaceId)
}

/** Installs a neutral multi-step workflow for tests of generic workflow behavior. */
export function installWorkflowStoreFixture(d: Database): void {
  const current = productionStepCatalogue(d).definition
  const steps = [
    {
      slug: 'rebase',
      title: 'Rebase and verify',
      stage: 'ship' as const,
      body: 'Run `{{gate}}` in `{{worktree}}` after rebasing on origin/{{trunk}}.',
      floor: ['command-exit' as const],
      job: null,
      autonomy: 'auto' as const,
      needs: ['gate', 'trunk'],
    },
    {
      slug: 'lens',
      title: 'Run independent review lenses',
      stage: 'review' as const,
      body: 'Review {{branch}} for {{key}}.',
      floor: ['recorded-artifact' as const],
      job: 'review-lens',
      autonomy: 'auto' as const,
      needs: [],
    },
    {
      slug: 'score',
      title: 'Score the lenses',
      stage: 'review' as const,
      body: 'Score every lens.',
      floor: ['recorded-artifact' as const],
      job: null,
      autonomy: 'auto' as const,
      needs: [],
    },
    {
      slug: 'ship-triage',
      title: 'Triage every finding',
      stage: 'review' as const,
      body: 'Triage every finding.',
      floor: ['ruling' as const],
      job: null,
      autonomy: 'ask' as const,
      needs: [],
    },
    {
      slug: 'complete',
      title: 'Complete the review',
      stage: 'review' as const,
      body: 'Complete the review.',
      floor: ['recorded-artifact' as const],
      job: null,
      autonomy: 'auto' as const,
      needs: [],
    },
    {
      slug: 'ship-fix',
      title: 'Fix accepted findings',
      stage: 'review' as const,
      body: 'Fix accepted findings.',
      floor: ['command-exit' as const, 'recorded-artifact' as const],
      job: 'implement',
      autonomy: 'ask' as const,
      needs: [],
    },
    {
      slug: 'pr',
      title: 'Open the pull request',
      stage: 'ship' as const,
      body: 'Open the pull request against {{trunk}}.',
      floor: ['command-exit' as const, 'recorded-artifact' as const],
      job: null,
      autonomy: 'ask' as const,
      needs: ['trunk'],
    },
    {
      slug: 'merge',
      title: 'Merge and pull',
      stage: 'ship' as const,
      body: 'Merge the pull request.',
      floor: ['command-exit' as const, 'recorded-artifact' as const],
      job: null,
      autonomy: 'ask' as const,
      needs: [],
    },
    {
      slug: 'close',
      title: 'Close the task',
      stage: 'ship' as const,
      body: 'Close the task.',
      floor: ['tracker-transition' as const],
      expectedStatus: '{{tracker.states.done}}',
      requirePullRequest: true,
      job: null,
      autonomy: 'auto' as const,
      needs: ['tracker'],
    },
  ]
  const catalogue = setStepCatalogueLocal(
    { ...current, steps: [...current.steps, ...steps] },
    'neutral workflow test fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(catalogue.n, 'publish neutral workflow test fixture', 'test', d)
  const workflow = setWorkflowLocal(
    'flow',
    {
      title: 'Fixture workflow',
      description: 'Exercises generic workflow behavior.',
      arguments: [
        { name: 'key', required: true, description: 'The task key.' },
        { name: 'branch', required: true, description: 'The branch.' },
        { name: 'worktree', required: true, rebind: true, description: 'The worktree path.' },
      ],
      modes: [
        {
          slug: 'default',
          title: 'Default',
          default: true,
          steps: [
            'rebase',
            'lens',
            'score',
            'ship-triage',
            'complete',
            'ship-fix',
            'pr',
            'merge',
            'close',
          ],
        },
      ],
    },
    'neutral workflow test fixture',
    'test',
    d,
  )
  promoteWorkflowLocal('flow', workflow.n, 'publish neutral workflow test fixture', 'test', d)
}
