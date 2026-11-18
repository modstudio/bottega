import { expect, test } from 'bun:test'
import type { McpServer } from '@modelcontextprotocol/server'
import { CALLER_ENVIRONMENT_KEY, recordCallerToken } from '../../../shared/record-caller.ts'
import { scopeMcpToolCallers } from './mcp-caller.ts'

test('registered MCP tools keep their caller scope across an await', async () => {
  const parentCaller = process.env[CALLER_ENVIRONMENT_KEY]
  process.env[CALLER_ENVIRONMENT_KEY] = 'hook:heartbeat'
  let registeredName = ''
  let handler: (() => Promise<unknown>) | undefined
  const server = {
    registerTool(_name: string, _config: object, registeredHandler: () => Promise<unknown>) {
      handler = registeredHandler
      return {}
    },
  } as unknown as McpServer

  try {
    scopeMcpToolCallers(server, (name) => {
      registeredName = name
    })
    const registerTool = server.registerTool as unknown as (
      name: string,
      config: object,
      registeredHandler: () => Promise<unknown>,
    ) => unknown
    registerTool('list_open_questions', {}, async () => {
      await Promise.resolve()
      return recordCallerToken()
    })

    expect(registeredName).toBe('list_open_questions')
    expect(await handler?.()).toBe('mcp:list_open_questions')
  } finally {
    if (parentCaller === undefined) delete process.env[CALLER_ENVIRONMENT_KEY]
    else process.env[CALLER_ENVIRONMENT_KEY] = parentCaller
  }
})
