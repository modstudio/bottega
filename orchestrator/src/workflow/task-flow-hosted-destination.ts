// concern: task-flow hosted destination
/** Resolves one mutation service call to its registered project's hosted space. */

import type { Database } from 'bun:sqlite'
import type { RecordRequestDestination } from '../record/record-api-client-paths.ts'
import { recordApiClient } from '../record/record-api-client.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import { requireProjectRecordDestination } from '../record/record-project-destination-client.ts'
import {
  currentRecordWriteDecision,
  throwIfRecordRefused,
} from '../record/record-write-authority.ts'
import { projectByName } from '../project/projects.ts'

export async function resolveTaskFlowDestination(
  projectName: string,
  database: Database,
  suppliedClient?: RecordTaskFlowClient,
): Promise<RecordRequestDestination | undefined> {
  const authority = currentRecordWriteDecision(database)
  throwIfRecordRefused(authority)
  if (authority.verdict === 'local-authoritative') return undefined
  const project = projectByName(projectName, database)
  if (!project) throw new Error(`project ${projectName} is not registered; register it, then retry`)
  const client = suppliedClient?.whoami ? suppliedClient : recordApiClient()
  const client = suppliedClient?.whoami ? suppliedClient as ReturnType<typeof recordApiClient> : recordApiClient()
  return {
    destinationSpaceId: await requireProjectRecordDestination(
      project.name,
      project.settings,
      client,
    ),
  }
}
