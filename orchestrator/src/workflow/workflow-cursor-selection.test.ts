import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { rememberProjectSpace } from '../project-space.ts'
import { applyWorkflowCatalogueRow } from '../record/record-cache-workflow.fixture.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { resolveWorkflowCursorMode } from './workflow-cursor-selection.ts'
import { seedWorkflows } from './workflow-seeds.ts'
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

test('a keyless cursor composed in a non-default mode resolves that mode', () => {
  const d = database()
  const context = { session: 'keyless-mode-session' }
  composeWorkflowWithCursor(SLUG, 'local-mode-project', 'non-default', {}, context, d, {}, {})
  expect(
    resolveWorkflowCursorMode(
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

const database = testDatabaseFixture((d) => {
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
] as const)('%s cursor resolves its default mode from its project space', (project, mode) => {
  expect(
    resolveWorkflowCursorMode(
      SLUG,
      project,
      undefined,
      {},
      {},
      'test caller',
      'pass a mode',
      database(),
    ),
  ).toBe(mode)
})
