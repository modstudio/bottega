// concern: agent-share
/** Publishes local agent declarations to one explicitly named hosted record space. */
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { shellQuote } from '../../../shared/shell-quote.ts'
import { type RecordApiClient, recordApiClient } from '../record/record-api-client.ts'
import type { RecordSpaceAgent } from '../record/record-space-agents.ts'
import { requireHostedRecord } from '../record/record-write-authority.ts'
import { recordWriteDestination } from '../record/record-write-destination.ts'
import { type AgentRow, agentRowDeclaration, agentRows } from './agent-registry.ts'

export const sharedAgentDeclaration: (row: AgentRow) => RecordSpaceAgent = agentRowDeclaration

function localAgent(name: string): AgentRow {
  const row = agentRows().find((candidate) => candidate.name === name)
  if (!row)
    throw new Error(
      `unknown local agent ${JSON.stringify(name)}; run \`${PLATFORM_SLUG} agent list\` to list local agents`,
    )
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
  const client = suppliedClient ?? recordApiClient()
  const result = await client.deleteSpaceAgent(name, await destination(client, space))
  if (!result.removed)
    throw new Error(
      `agent ${JSON.stringify(name)} is not declared in space ${JSON.stringify(space)}; run \`${PLATFORM_SLUG} agent share ${shellQuote(name)} --space ${shellQuote(space)}\` to declare it, or the declaration may already be absent`,
    )
}
