import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { composeWorkflowWithCursor, nextWorkflowStep } from './workflow-cursor.ts'
import {
  context,
  database,
  installEvidence,
  matchingCheckout,
  testPorts,
} from './workflow-cursor-test.fixture.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

test('compose protects an open branch while worktree compose and branch next still rebind', () => {
  const d = database()
  const slug = 'compose-rebind-fixture'
  const draft = setWorkflowLocal(
    slug,
    {
      title: 'Compose rebind fixture',
      description: 'Exercises compose-only cursor argument rebinding.',
      arguments: [
        { name: 'key', required: true, description: 'Task key.' },
        { name: 'branch', required: true, rebind: true, description: 'Review branch.' },
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
  promoteWorkflowLocal(slug, draft.n, 'test fixture', 'test', d)
  composeWorkflowWithCursor(
    slug,
    'fixture',
    'default',
    { key: 'DEV-822', branch: 'DEV-822-old', worktree: '/tmp/old' },
    context,
    d,
    {},
    {},
  )

  composeWorkflowWithCursor(
    slug,
    'fixture',
    'default',
    { key: 'DEV-822', branch: 'DEV-822-old', worktree: '/tmp/reopened' },
    context,
    d,
    {},
    {},
  )
  expect(() =>
    composeWorkflowWithCursor(
      slug,
      'fixture',
      'default',
      { key: 'DEV-822', branch: 'DEV-822-new', worktree: '/tmp/reopened' },
      context,
      d,
      {},
      {},
    ),
  ).toThrow(
    `workflow compose cannot rebind open cursor 1 from stored branch "DEV-822-old" at step 1 lens; ` +
      `finish it with ${PLATFORM_SLUG} workflow next ${slug} --cursor 1, or abandon it with ` +
      `${PLATFORM_SLUG} workflow abandon ${slug} --cursor 1 --reason "<text>"; a renamed branch of the ` +
      `same change continues through ${PLATFORM_SLUG} workflow next ${slug} --cursor 1 with the new branch`,
  )

  const renamedArgs = {
    key: 'DEV-822',
    branch: 'DEV-822-new',
    worktree: '/tmp/reopened',
  }
  expect(
    nextWorkflowStep(
      slug,
      'fixture',
      'default',
      renamedArgs,
      'reviewed',
      context,
      d,
      installEvidence(d, 'fixture', slug, 'default', renamedArgs, context),
      {
        ...testPorts,
        resolveCheckout: () => ({ ...matchingCheckout, branch: renamedArgs.branch }),
      },
    ),
  ).toContain(`this is the last step of ${slug}`)
  const row = d.query('SELECT args,closed FROM workflow_cursor').get() as {
    args: string
    closed: string
  }
  expect(JSON.parse(row.args)).toMatchObject({
    branch: 'DEV-822-new',
    worktree: '/tmp/reopened',
  })
  expect(JSON.parse(row.closed)).toEqual([
    expect.objectContaining({
      event: 'argument-rebound',
      name: 'worktree',
      oldValue: '/tmp/old',
      newValue: '/tmp/reopened',
    }),
    expect.objectContaining({
      event: 'argument-rebound',
      name: 'branch',
      oldValue: 'DEV-822-old',
      newValue: 'DEV-822-new',
    }),
    expect.objectContaining({ n: 1, slug: 'lens', note: 'reviewed' }),
  ])
})
