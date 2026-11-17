import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import { applyWorkflowCatalogueRow } from '../record/record-cache-workflow.fixture.ts'
import { productionStepCatalogue } from './step-catalogue.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { workflowCursorListCommand } from './workflow-cursor-format.ts'
import {
  resolveWorkflowCursorMode,
  selectByHandle,
  workflowCursorProjectScope,
} from './workflow-cursor-selection.ts'
import { args, context, database } from './workflow-cursor-test.fixture.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import {
  workflowCommandPresentation as presentation,
  publishCursorWorkflowFixture as publishCursorWorkflow,
  registerCurrentWorkflowProject as registerCurrentProject,
  runWorkflowCommand as workflowCommand,
} from './workflow-store.fixture.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

const SLUG = 'space-default-mode'
const definition = (mode: string) => ({
  title: 'Space default mode',
  description: 'Exercises cursor default-mode lookup routing.',
  arguments: [],
  modes: [
    { slug: mode, title: mode, default: true, steps: ['verify'] },
    { slug: 'non-default', title: 'Non-default', steps: ['verify'] },
  ],
})

test('listing scope honors explicit flags and refuses an unresolved cwd', () => {
  expect(workflowCursorProjectScope({}, 'fixture', '/fixture/worktree')).toBe('fixture')
  expect(workflowCursorProjectScope({ project: 'other' }, 'fixture', '/fixture/worktree')).toBe(
    'other',
  )
  expect(
    workflowCursorProjectScope({ session: 'session-one' }, 'fixture', '/fixture/worktree'),
  ).toBeUndefined()
  expect(
    workflowCursorProjectScope(
      { session: 'session-one', project: 'other' },
      'fixture',
      '/fixture/worktree',
    ),
  ).toBe('other')
  expect(workflowCursorProjectScope({ all: true }, 'fixture', '/fixture/worktree')).toBeUndefined()
  expect(() => workflowCursorProjectScope({}, undefined, '/tmp')).toThrow(
    'cannot list workflow cursors from /tmp: pass --project, --session or --all',
  )
})

test('a keyless cursor composed in a non-default mode resolves that mode', async () => {
  const d = restoredDatabase()
  const context = { session: 'keyless-mode-session' }
  await composeWorkflowWithCursor(SLUG, 'local-mode-project', 'non-default', {}, context, d, {}, {})
  expect(
    await resolveWorkflowCursorMode(
      SLUG,
      'local-mode-project',
      undefined,
      {},
      context,
      'test caller',
      'pass a mode',
      d,
    ),
  ).toBe('non-default')
})

const restoredDatabase = testDatabaseFixture((d) => {
  seedWorkflows(d)
  for (const project of ['hosted-mode-project', 'local-mode-project'])
    d.query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)').run(
      newRecordId(),
      project,
      `/fixture/${project}`,
      'bun',
      JSON.stringify({ gate: 'bun run check', docs: { protocol: 'orch-docs' } }),
    )
  const local = setWorkflowLocal(SLUG, definition('local'), 'local fixture', 'test', d)
  promoteWorkflowLocal(SLUG, local.n, 'publish local fixture', 'test', d)

  const spaceId = newRecordId()
  const workflowId = newRecordId()
  const at = '2026-10-21T12:00:00.000Z'
  rememberProjectSpace(d, 'hosted-mode-project', spaceId)
  applyWorkflowCatalogueRow(d, 'workflow', {
    id: workflowId,
    spaceId,
    slug: SLUG,
    generation: 1,
    createdAt: at,
  })
  applyWorkflowCatalogueRow(d, 'workflow_version', {
    id: newRecordId(),
    spaceId,
    ownerId: workflowId,
    n: 20,
    status: 'production',
    definition: JSON.stringify(definition('hosted')),
    author: 'hosted',
    reason: 'hosted fixture',
    createdAt: at,
    promotedAt: at,
    retiredAt: null,
  })
})

test.each([
  ['hosted-mode-project', 'hosted'],
  ['local-mode-project', 'local'],
] as const)('%s cursor resolves its default mode from its project space', async (project, mode) => {
  expect(
    await resolveWorkflowCursorMode(
      SLUG,
      project,
      undefined,
      {},
      {},
      'test caller',
      'pass a mode',
      restoredDatabase(),
    ),
  ).toBe(mode)
})

test('a local cursor handle outside a registered project requires a project option', async () => {
  const d = database()
  const composed = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    {},
  )
  d.query('UPDATE project SET path=? WHERE name=?').run('/fixture-not-this-cwd', 'fixture')

  expect(selectByHandle(composed.cursor!.id, {}, d)).rejects.toThrow('pass --project <PROJECT>')
})

test('a cursor absent from the resolved project tells the caller to list cursors again', async () => {
  const d = database()
  const composed = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    {},
  )

  expect(selectByHandle(composed.cursor!.id, { project: 'missing-project' }, d)).rejects.toThrow(
    `cursor handles changed to per-project numbers, so list cursors again with ${workflowCursorListCommand}`,
  )
})

test('CLI abandon refuses another sessions cursor until its owner is acknowledged', async () => {
  const project = 'cursor-abandon-owner-project'
  const slug = 'cursor-abandon-owner'
  const step = productionStepCatalogue().definition.steps.find(
    ({ slug }) => slug === 'blast-radius',
  )!.slug
  registerCurrentProject(project)
  publishCursorWorkflow(slug, [{ slug: 'default', title: 'Default', default: true, steps: [step] }])
  const opened = await composeWorkflowWithCursor(
    slug,
    project,
    'default',
    { key: 'DEV-2365' },
    {},
    undefined,
    {},
    {},
  )
  const cursor = opened.cursor!.id
  db()
    .query('UPDATE workflow_cursor SET session_id=? WHERE number=?')
    .run('foreign-session', cursor)
  const abandon = (selected: number, ...tail: string[]) =>
    workflowCommand(
      [
        'workflow',
        'abandon',
        '--cursor',
        String(selected),
        '--project',
        project,
        '--reason',
        'test',
        ...tail,
      ],
      presentation([]),
    )
  await expect(abandon(cursor)).rejects.toThrow(
    'owned by session foreign-session; rerun with --owner-session foreign-session',
  )
  await abandon(cursor, '--owner-session', 'foreign-session')
  expect(db().query('SELECT state FROM workflow_cursor WHERE number=?').get(cursor)).toEqual({
    state: 'abandoned',
  })
})

test('CLI keyed abandon refuses another sessions cursor until its owner is acknowledged', async () => {
  const project = 'keyed-abandon-owner-project'
  const slug = 'keyed-abandon-owner'
  const key = 'DEV-2365-keyed'
  const step = productionStepCatalogue().definition.steps.find(
    ({ slug }) => slug === 'blast-radius',
  )!.slug
  registerCurrentProject(project)
  publishCursorWorkflow(slug, [{ slug: 'default', title: 'Default', default: true, steps: [step] }])
  const opened = await composeWorkflowWithCursor(
    slug,
    project,
    'default',
    { key },
    { session: 'foreign-keyed-session' },
    undefined,
    {},
    {},
  )
  const argv = [
    'workflow',
    'abandon',
    slug,
    '--project',
    project,
    '--mode',
    'default',
    '--arg',
    `key=${key}`,
    '--reason',
    'test',
  ]

  await expect(workflowCommand(argv, presentation([]))).rejects.toThrow(
    'owned by session foreign-keyed-session; rerun with --owner-session foreign-keyed-session',
  )
  await workflowCommand([...argv, '--owner-session', 'foreign-keyed-session'], presentation([]))
  expect(
    db()
      .query('SELECT state FROM workflow_cursor WHERE number=? AND project=?')
      .get(opened.cursor!.id, project),
  ).toEqual({ state: 'abandoned' })
})

describe('CLI abandon for the owning session', () => {
  let priorSession: string | undefined

  beforeEach(() => {
    priorSession = process.env.CLAUDE_CODE_SESSION_ID
    process.env.CLAUDE_CODE_SESSION_ID = 'own-session'
  })

  afterEach(() => {
    if (priorSession === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = priorSession
  })

  test('abandons its own cursor without an owner-session flag', async () => {
    const project = 'cursor-abandon-own-session-project'
    const slug = 'cursor-abandon-own-session'
    const step = productionStepCatalogue().definition.steps.find(
      ({ slug }) => slug === 'blast-radius',
    )!.slug
    registerCurrentProject(project)
    publishCursorWorkflow(slug, [
      { slug: 'default', title: 'Default', default: true, steps: [step] },
    ])
    const own = await composeWorkflowWithCursor(
      slug,
      project,
      'default',
      { key: 'DEV-2365-own' },
      {},
      undefined,
      {},
      {},
    )
    db()
      .query('UPDATE workflow_cursor SET session_id=? WHERE number=? AND project=?')
      .run('own-session', own.cursor!.id, project)
    await workflowCommand(
      [
        'workflow',
        'abandon',
        '--cursor',
        String(own.cursor!.id),
        '--project',
        project,
        '--reason',
        'test',
      ],
      presentation([]),
    )
    expect(
      db().query('SELECT state FROM workflow_cursor WHERE number=?').get(own.cursor!.id),
    ).toEqual({ state: 'abandoned' })
  })
})
