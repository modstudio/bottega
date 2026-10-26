import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { type LandingBranchFacts, landingBranchRefusal } from './workflow-compose-branch.ts'
import {
  workflowCommandPresentation as presentation,
  runWorkflowCommand,
} from './workflow-store.fixture.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

const facts = (overrides: Partial<LandingBranchFacts> = {}): LandingBranchFacts => ({
  workflow: 'ship-task',
  branch: 'DEV-1-built',
  landingBranch: 'main',
  commitsPastLanding: 0,
  ...overrides,
})

test('a landing workflow refuses a branch the landing branch already contains', () => {
  expect(landingBranchRefusal(facts())).toBe(
    'refusing to compose ship-task for branch DEV-1-built: it has no commits past main, and ' +
      `ship-task lands a built branch; build the change first with \`${PLATFORM_SLUG} run start implement --key <key>\``,
  )
})

test('a landing workflow composes a branch that carries commits past the landing branch', () => {
  expect(landingBranchRefusal(facts({ commitsPastLanding: 3 }))).toBeNull()
})

test('an unread commit count never refuses a composition', () => {
  expect(landingBranchRefusal(facts({ commitsPastLanding: null }))).toBeNull()
})

test('a workflow that builds its own branch is never refused', () => {
  expect(landingBranchRefusal(facts({ workflow: 'plan-task', commitsPastLanding: 0 }))).toBeNull()
})

/** A registered project and a local `ship-task`, so a compose command can be driven without git. */
function publishLandingFixture(project: string, key: string) {
  upsertProject({
    recordId: newRecordId(),
    name: project,
    path: `/fixture/${project}`,
    stack: 'bun',
    settings: {
      gate: 'bun run check',
      trunk: 'main',
      docs: { protocol: 'orch-docs' },
      tracker: { kind: 'hub', protocol: 'hub' },
    },
  })
  const draft = setWorkflowLocal(
    'ship-task',
    {
      title: 'Land a built branch',
      description: 'Lands a branch an implementation run built.',
      arguments: [
        { name: 'key', required: true, description: 'The task key.' },
        { name: 'branch', required: true, description: 'The branch to land.' },
      ],
      modes: [
        {
          slug: 'merge',
          title: 'Land through merge',
          entry: 'Does the branch stop at the merge into the landing branch?',
          steps: ['diagnose'],
        },
      ],
    },
    'landing branch refusal fixture',
    'test',
  )
  promoteWorkflowLocal('ship-task', draft.n, 'publish landing branch refusal fixture', 'test')
  return () =>
    db()
      .query<{ state: string }, [string]>(
        "SELECT state FROM workflow_cursor WHERE workflow_slug='ship-task' AND workflow_key=?",
      )
      .get(key)?.state ?? null
}

test('the compose command opens no cursor for a branch with nothing past the landing branch', async () => {
  const project = 'compose-landing-branch'
  const key = 'DEV-1575-EMPTY'
  const branch = 'DEV-1575-empty'
  const cursorState = publishLandingFixture(project, key)
  const compose = (commitCount: () => number | null) =>
    runWorkflowCommand(
      [
        'workflow',
        'compose',
        'ship-task',
        '--project',
        project,
        '--mode',
        'merge',
        '--arg',
        `key=${key}`,
        '--arg',
        `branch=${branch}`,
      ],
      presentation([]),
      { commitCount },
    )

  await expect(compose(() => 0)).rejects.toThrow(
    `refusing to compose ship-task for branch ${branch}: it has no commits past main, and ` +
      `ship-task lands a built branch; build the change first with \`${PLATFORM_SLUG} run start implement --key <key>\``,
  )
  expect(cursorState()).toBeNull()

  await compose(() => 1)
  expect(cursorState()).toBe('running')
})
