import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { testDatabaseFixture } from '../database/test-database.fixture.ts'
import { rememberProjectSpace } from '../project-space.ts'
import { applyWorkflowCatalogueRow } from '../record/record-cache-workflow.fixture.ts'
import { applyCursorArguments } from './workflow-cursor-arguments.ts'
import { seedWorkflows } from './workflow-seeds.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

const SLUG = 'space-rebind'
const definition = {
  title: 'Space rebind',
  description: 'Exercises cursor argument lookup routing.',
  arguments: [
    { name: 'key', required: true, description: 'Task key.' },
    { name: 'branch', required: false, rebind: true, description: 'Current branch.' },
  ],
  modes: [],
}

const database = testDatabaseFixture((d) => {
  seedWorkflows(d)
  for (const project of ['hosted-rebind-project', 'local-rebind-project'])
    d.query('INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?)').run(
      newRecordId(),
      project,
      `/fixture/${project}`,
      'bun',
      '{}',
    )
  const local = setWorkflowLocal(SLUG, definition, 'local fixture', 'test', d)
  promoteWorkflowLocal(SLUG, local.n, 'publish local fixture', 'test', d)

  const spaceId = newRecordId()
  const workflowId = newRecordId()
  const at = '2026-10-21T12:00:00.000Z'
  rememberProjectSpace(d, 'hosted-rebind-project', spaceId)
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
    definition: JSON.stringify(definition),
    author: 'hosted',
    reason: 'hosted fixture',
    createdAt: at,
    promotedAt: at,
    retiredAt: null,
  })
})

test.each([
  ['hosted-rebind-project', 20],
  ['local-rebind-project', 1],
] as const)(
  '%s cursor resolves rebindable arguments from its project space',
  (project, version) => {
    const row = {
      id: -1,
      record_id: newRecordId(),
      project,
      workflow_slug: SLUG,
      workflow_version: version,
      args: JSON.stringify({ key: 'DEV-1499', branch: 'before' }),
      closed: '[]',
    }

    expect(applyCursorArguments(row, { key: 'DEV-1499', branch: 'after' }, database())).toEqual({
      key: 'DEV-1499',
      branch: 'after',
    })
  },
)
