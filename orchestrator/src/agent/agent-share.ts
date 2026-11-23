// concern: agent-share
/** Publishes local agent declarations to one explicitly named hosted record space. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { type RecordApiClient, recordApiClient } from '../record/record-api-client.ts'
import type { RecordSpaceAgent } from '../record/record-space-agents.ts'
import { requireHostedRecord } from '../record/record-write-authority.ts'
import { recordWriteDestination } from '../record/record-write-destination.ts'
import { type AgentRow, agentRows } from './agent-registry.ts'

export function sharedAgentDeclaration(row: AgentRow): RecordSpaceAgent {
  return {
    name: row.name,
    harness: row.harness,
    backend: row.backend,
    model: row.model,
    baseUrl: row.base_url,
    transport: row.transport,
    provider: row.provider,
    apiKeySecret: row.api_key_secret,
    requestSettings: row.request_settings ? JSON.parse(row.request_settings) : null,
    jobs: row.jobs ? JSON.parse(row.jobs) : null,
    preferredJobs: row.preferred_jobs ? JSON.parse(row.preferred_jobs) : null,
    maxConcurrent: row.max_concurrent,
    routeMetered: Boolean(row.route_metered),
    trainsOnInputs: Boolean(row.trains_on_inputs),
    operatedBy: row.operated_by,
    billing: row.billing,
  }
}

function localAgent(name: string): AgentRow {
  const row = agentRows().find((candidate) => candidate.name === name)
  if (!row) throw new Error(`unknown local agent ${JSON.stringify(name)}`)
  return row
}

async function destination(client: RecordApiClient, space: string) {
  return recordWriteDestination(client, { kind: 'space', value: space })
}

export async function shareAgent(
  name: string,
  space: string,
  suppliedClient?: RecordApiClient,
): Promise<RecordSpaceAgent> {
  requireHostedRecord(`${PLATFORM_SLUG} agent share`)
  const declaration = sharedAgentDeclaration(localAgent(name))
  const client = suppliedClient ?? recordApiClient()
  return client.upsertSpaceAgent(declaration, await destination(client, space))
}

export async function unshareAgent(
  name: string,
  space: string,
  suppliedClient?: RecordApiClient,
): Promise<void> {
  requireHostedRecord(`${PLATFORM_SLUG} agent unshare`)
  localAgent(name)
  const client = suppliedClient ?? recordApiClient()
  const result = await client.deleteSpaceAgent(name, await destination(client, space))
  if (!result.removed)
    throw new Error(`agent ${JSON.stringify(name)} is not declared in space ${space}`)
}
