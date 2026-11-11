import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rememberProjectSpace } from '../project-space-cache.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { getWorkflowStepWithCursor } from './workflow-cursor-serve.ts'
import { args, context, database } from './workflow-cursor-test.fixture.ts'
import { promoteWorkflowLocal, setWorkflowLocal, showResolvedWorkflow } from './workflows.ts'

const hostedUrl = 'https://record.example.test'
const destinationSpaceId = 'fixture-space'
let priorHostedUrl: string | undefined

beforeEach(() => {
  priorHostedUrl = process.env.BOTTEGA_RECORD_API_URL
})

afterEach(() => {
  if (priorHostedUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = priorHostedUrl
})

test('serving a rebound argument writes hosted-first and preserves the local row on failure', async () => {
  delete process.env.BOTTEGA_RECORD_API_URL
  const d = database()
  const opened = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    {},
  )
  const cursor = d
    .query<{ record_id: string; step_slug: string; args: string; closed: string }, [number]>(
      'SELECT record_id,step_slug,args,closed FROM workflow_cursor WHERE number=?',
    )
    .get(opened.cursor!.id)!
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
  process.env.BOTTEGA_RECORD_API_URL = hostedUrl
  let refusal: Error | null = null
  let expectedBranch = 'rebound-one'
  let expectedLocal = { args: cursor.args, closed: cursor.closed }
  const taskFlowClient: RecordTaskFlowClient = {
    whoami: async () => ({
      user: { id: 'fixture-user' },
      activeSpaceId: destinationSpaceId,
      personalSpaceId: destinationSpaceId,
      memberships: [{ space_id: destinationSpaceId, slug: 'fixture-space', permission: 'write' }],
    }),
    updateTaskFlowStage: async (input) => {
      expect(input.stages[0]!.values.arguments).toEqual({ ...args, branch: expectedBranch })
      expect(input.stages[0]!.values.closedStepNotes).toHaveLength(
        expectedBranch === 'rebound-one' ? 1 : 2,
      )
      expect(d.query('SELECT args,closed FROM workflow_cursor WHERE record_id=?').get(cursor.record_id)).toEqual({
        args: expectedLocal.args,
        closed: expectedLocal.closed,
      })
      if (refusal) throw refusal
      return { revisions: { [cursor.record_id]: 17 } }
    },
  }
  const hostedContext = { ...context, taskFlowClient }

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
    d.query('SELECT args,closed,revision FROM workflow_cursor WHERE record_id=?').get(cursor.record_id),
  ).toEqual(afterSuccess)
})
