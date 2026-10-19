import { expect, test } from 'bun:test'
import { recordWorkflowClient } from './record-api-client-workflow.ts'
import type { RecordWorkflowImportInput } from './record-workflow-contract.ts'

const input: RecordWorkflowImportInput = {
  dryRun: false,
  step_catalogue: [],
  step_catalogue_version: [],
  step_catalogue_event: [],
  workflow: [],
  workflow_version: [],
  workflow_event: [],
}

test('workflow imports use only the reconciled v2 route', async () => {
  const paths: string[] = []
  const client = recordWorkflowClient(async (path) => {
    paths.push(path)
    return { inserted: 0, alreadyPresent: 0, skipped: [], outcomes: [] } as never
  })
  await client.importWorkflowCatalogue!(input)
  expect(paths).toEqual(['/v1/workflow-catalogue/import/v2'])
})

test.each([404, 405])('workflow import refuses an old record API response %s', async (status) => {
  const client = recordWorkflowClient(async () => {
    throw { status }
  })
  await expect(client.importWorkflowCatalogue!(input)).rejects.toThrow(
    'record API predates reconciled workflow import; release hosted-api, then retry',
  )
})
