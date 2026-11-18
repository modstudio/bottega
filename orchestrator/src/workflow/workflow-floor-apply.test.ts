import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { boardClaimList } from '../board/board-operations.ts'
import {
  productionStepCatalogue,
  promoteStepCatalogueLocal,
  setStepCatalogueLocal,
} from './step-catalogue.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import {
  args,
  context,
  database,
  selectAndNextWorkflowStep,
} from './workflow-cursor-test.fixture.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

function installKeylessWorkflow(
  d: ReturnType<typeof database>,
  slug: string,
  steps: readonly string[],
) {
  const current = productionStepCatalogue(d).definition
  const catalogue = setStepCatalogueLocal(
    {
      ...current,
      steps: [
        ...current.steps,
        ...steps.map((slug) => ({
          slug,
          title: slug,
          body: `Close ${slug}.`,
          stage: 'plan' as const,
          floor: ['recorded-artifact' as const],
          jobs: [],
          actions: [],
          autonomy: 'auto' as const,
          needs: [],
        })),
      ],
    },
    'keyless ownership fixture',
    'test',
    d,
  )
  promoteStepCatalogueLocal(catalogue.n, 'keyless ownership fixture', 'test', d)
  const draft = setWorkflowLocal(
    slug,
    {
      title: slug,
      description: 'Exercises keyless cursor ownership on close.',
      arguments: [],
      modes: [{ slug: 'default', title: 'Default', default: true, steps }],
    },
    'keyless ownership fixture',
    'test',
    d,
  )
  promoteWorkflowLocal(slug, draft.n, 'keyless ownership fixture', 'test', d)
}

test.each([
  { name: 'advance', steps: ['ownership-first', 'ownership-last'] },
  { name: 'finish', steps: ['ownership-first'] },
  {
    name: 'advance with task adoption',
    steps: ['ownership-first', 'ownership-last'],
    task: 'DEV-2422',
  },
])('a foreign keyless $name refuses before writing', async ({ steps, task }) => {
  const d = database()
  const slug = `keyless-foreign-${steps.length}`
  installKeylessWorkflow(d, slug, steps)
  const owner = { session: 'owner-session' }
  const keylessArgs = {}
  const opened = await composeWorkflowWithCursor(
    slug,
    'fixture',
    'default',
    keylessArgs,
    owner,
    d,
    {},
    {},
  )
  const cursor = opened.cursor!.id
  d.query("UPDATE workflow_cursor SET enforcement='note-only' WHERE number=?").run(cursor)

  await expect(
    selectAndNextWorkflowStep(
      slug,
      'fixture',
      'default',
      keylessArgs,
      'closed by foreign session',
      { session: 'foreign-session' },
      d,
      task ? { task } : {},
      undefined,
      cursor,
    ),
  ).rejects.toThrow(
    `workflow cursor ${cursor} is owned by session owner-session; a keyless cursor changes owner only through an explicit takeover. Take it over with: ${PLATFORM_SLUG} workflow abandon --cursor ${cursor} --project fixture --owner-session owner-session; then compose a new cursor with: ${PLATFORM_SLUG} workflow compose ${slug} --project fixture --mode default`,
  )
  expect(
    d
      .query('SELECT session_id,workflow_key,ordinal,state FROM workflow_cursor WHERE number=?')
      .get(cursor),
  ).toEqual({ session_id: 'owner-session', workflow_key: '', ordinal: 0, state: 'running' })
})

test('a foreign keyed advance keeps the recorded taken-over claim behavior', async () => {
  const d = database()
  await composeWorkflowWithCursor('flow', 'fixture', 'default', args, context, d, {}, {})
  d.query("UPDATE workflow_cursor SET enforcement='note-only'").run()

  await selectAndNextWorkflowStep(
    'flow',
    'fixture',
    'default',
    args,
    'closed by foreign session',
    { ...context, session: 'foreign-session' },
    d,
  )

  const claims = (
    await boardClaimList('fixture', true, {
      env: {},
      database: d,
      taskCursorAuthority: { mode: 'coverage-read', session: null },
    })
  ).claims
  expect(claims).toHaveLength(2)
  expect(claims[0]).toMatchObject({ holder: 'session-one', closeReason: 'taken-over' })
  expect(claims[1]).toMatchObject({ holder: 'foreign-session', live: true })
})
