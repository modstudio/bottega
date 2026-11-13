// concern: MCP hosted workflow fixture
/** Builds the two-stage hosted record used by the MCP handle integration test. */

import type { Database } from 'bun:sqlite'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import type { HostedTaskFlow } from '../record/record-task-flow-contract.ts'

type SecondStage = {
  flowId: string
  recordId: string
  number: number
  workflowVersionId: string
  catalogueVersionId: string
  args: Record<string, string>
}

export function mcpTaskFlowStageIdentity(database: Database, number: number) {
  return database
    .query<
      {
        record_id: string
        workflow_version_record_id: string
        catalogue_version_record_id: string
      },
      [number]
    >(
      `SELECT record_id,workflow_version_record_id,catalogue_version_record_id
       FROM workflow_cursor WHERE number=?`,
    )
    .get(number)!
}

export function createMcpTaskFlowMemory(hosted: HostedTaskFlow, second: SecondStage) {
  if (!hosted.stage) throw new Error('MCP hosted workflow fixture requires an open stage')
  return createMemoryRecordApiClient({
    taskFlowStages: [
      { flow: hosted.flow, stage: hosted.stage },
      {
        flow: {
          ...hosted.flow,
          id: second.flowId,
          taskId: null,
          taskKey: null,
          openStageRecordId: second.recordId,
        },
        stage: {
          ...hosted.stage,
          id: second.recordId,
          flowRecordId: second.flowId,
          number: second.number,
          workflowKey: 'DEV-1082-MCP-B',
          workflowVersionId: second.workflowVersionId,
          catalogueVersionId: second.catalogueVersionId,
          arguments: second.args,
          activeOrdinal: 0,
          activeSlug: 'diagnose',
          closedStepNotes: [],
        },
      },
    ],
  })
}
