import { expect, test } from 'bun:test'
import { resolvedRecordOrigin } from '../../../shared/record-api-url.ts'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import { rememberActiveRecordSpace } from '../project-space.ts'
import { rememberProjectSpace } from '../project-space-cache.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { getWorkflowStepWithCursor } from './workflow-cursor-serve.ts'
import { args, context, database } from './workflow-cursor-test.fixture.ts'
import { promoteWorkflowLocal, setWorkflowLocal, showResolvedWorkflow } from './workflows.ts'

const destinationSpaceId = 'fixture-space'

test('serving a rebound argument writes hosted-first and preserves the local row on failure', async () => {
  const d = database()
  const current = showResolvedWorkflow('flow', undefined, 'fixture', d).definition
  const rebindable = setWorkflowLocal(
    'flow',
    {
      ...current,
      arguments: current.arguments.map((argument) =>
        argument.name === 'branch' ? { ...argument, rebind: true } : argument,
      ),
    },
    'serve rebound fixture',
    'test',
    d,
  )
  promoteWorkflowLocal('flow', rebindable.n, 'serve rebound fixture', 'test', d)
  for (const table of ['workflow', 'workflow_version', 'step_catalogue', 'step_catalogue_version'])
    d.query(`UPDATE ${table} SET space_id=?`).run(destinationSpaceId)
  rememberProjectSpace(d, 'fixture', destinationSpaceId)
  rememberActiveRecordSpace(d, destinationSpaceId)
  d.query('INSERT INTO record_install_binding (id,bound_at,record_origin) VALUES (1,?,?)').run(
    '2026-11-10T00:00:00.000Z',
    resolvedRecordOrigin(),
  )
  let refusal: Error | null = null
  let expectedBranch = 'rebound-one'
  let cursor!: { record_id: string; step_slug: string; args: string; closed: string }
  let expectedLocal!: { args: string; closed: string }
  const memory = createMemoryRecordApiClient({
    taskFlowWorkflowVersionNumbers: Object.fromEntries([
      ...d
        .query<{ record_id: string; n: number }, []>('SELECT record_id,n FROM workflow_version')
        .all()
        .map((row) => [row.record_id, row.n] as const),
      ...d
        .query<{ record_id: string }, []>('SELECT record_id FROM workflow')
        .all()
        .map((row) => [row.record_id, rebindable.n] as const),
    ]),
    taskFlowCatalogueVersionNumbers: Object.fromEntries(
      d
        .query<{ record_id: string; n: number }, []>(
          'SELECT record_id,n FROM step_catalogue_version',
        )
        .all()
        .map((row) => [row.record_id, row.n]),
    ),
  })
  const taskFlowClient: RecordTaskFlowClient = {
    ...memory,
    whoami: async () => ({
      user: { id: 'fixture-user' },
      activeSpaceId: destinationSpaceId,
      personalSpaceId: destinationSpaceId,
      memberships: [{ space_id: destinationSpaceId, slug: 'fixture-space', permission: 'write' }],
    }),
    updateTaskFlowStage: async (input, destination) => {
      expect(input.stages[0]!.values.arguments).toEqual({ ...args, branch: expectedBranch })
      expect(input.stages[0]!.values.closedStepNotes).toHaveLength(
        expectedBranch === 'rebound-one' ? 1 : 2,
      )
      expect(
        d.query('SELECT args,closed FROM workflow_cursor WHERE record_id=?').get(cursor.record_id),
      ).toEqual({
        args: expectedLocal.args,
        closed: expectedLocal.closed,
      })
      if (refusal) throw refusal
      await memory.updateTaskFlowStage!(input, destination)
      return { revisions: { [cursor.record_id]: 17 } }
    },
  }
  const hostedContext = { ...context, taskFlowClient }
  const opened = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    args,
    hostedContext,
    d,
    {},
    {},
  )
  cursor = d
    .query<{ record_id: string; step_slug: string; args: string; closed: string }, [number]>(
      'SELECT record_id,step_slug,args,closed FROM workflow_cursor WHERE number=?',
    )
    .get(opened.cursor!.id)!
  const projectId = d
    .query<{ record_id: string }, [string]>('SELECT record_id FROM project WHERE name=?')
    .get('fixture')!.record_id
  const listed = await taskFlowClient.listTaskFlowStages!(
    { projectId, number: opened.cursor!.id },
    { destinationSpaceId },
  )
  expect(listed.items).toHaveLength(1)
  expect(listed.items[0]!.stage.workflowVersionNumber).toBe(rebindable.n)
  expectedLocal = { args: cursor.args, closed: cursor.closed }

  await getWorkflowStepWithCursor(
    'flow',
    'fixture',
    cursor.step_slug,
    { ...args, branch: 'rebound-one' },
    'default',
    hostedContext,
    d,
    {},
    opened.cursor!.id,
  )
  const afterSuccess = d
    .query<{ args: string; closed: string; revision: number }, [string]>(
      'SELECT args,closed,revision FROM workflow_cursor WHERE record_id=?',
    )
    .get(cursor.record_id)!
  expect(JSON.parse(afterSuccess.args)).toEqual({ ...args, branch: 'rebound-one' })
  expect(JSON.parse(afterSuccess.closed)).toHaveLength(1)
  expect(afterSuccess.revision).toBe(17)

  expectedLocal = afterSuccess
  refusal = new Error('hosted serve unavailable')
  expectedBranch = 'rebound-two'
  await expect(
    getWorkflowStepWithCursor(
      'flow',
      'fixture',
      cursor.step_slug,
      { ...args, branch: 'rebound-two' },
      'default',
      hostedContext,
      d,
      {},
      opened.cursor!.id,
    ),
  ).rejects.toThrow('hosted serve unavailable')
  expect(
    d
      .query('SELECT args,closed,revision FROM workflow_cursor WHERE record_id=?')
      .get(cursor.record_id),
  ).toEqual(afterSuccess)
})
