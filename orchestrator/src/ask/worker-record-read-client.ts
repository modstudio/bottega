// concern: confined worker ask client
/** Calls one run-scoped record read through the host ask proxy. */

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'

function textContent(result: Awaited<ReturnType<Client['callTool']>>): string {
  const item = result.content.find(
    (content): content is { type: 'text'; text: string } =>
      content.type === 'text' && typeof content.text === 'string',
  )
  if (!item) throw new Error('the ask server returned no text')
  if (result.isError) throw new Error(item.text)
  return item.text
}

export async function callWorkerRecordRead<T = unknown>(
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const [command, ...commandArguments] = bottegaEntryArgv('ask-proxy')
  const transport = new StdioClientTransport({
    command: command!,
    args: commandArguments,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    stderr: 'pipe',
  })
  const client = new Client({ name: `${PLATFORM_SLUG}-worker-record-read`, version: '1' })
  try {
    await client.connect(transport)
    return JSON.parse(textContent(await client.callTool({ name, arguments: args }))) as T
  } finally {
    await client.close()
  }
}
