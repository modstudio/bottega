import { expect, test } from 'bun:test'
import type { McpServer } from '@modelcontextprotocol/server'
import { CALLER_ENVIRONMENT_KEY, recordCallerToken } from '../../../shared/record-caller.ts'
import { classifyCaller } from '../caller-classification.ts'
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
    scopeMcpToolCallers(server, {
      onRegister: (name) => {
        registeredName = name
      },
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

test('concurrent MCP calls classify their own request sessions', async () => {
  let handler:
    | ((
        input: unknown,
        context: { mcpReq: { _meta?: Record<string, unknown> } },
      ) => Promise<unknown>)
    | undefined
  const server = {
    registerTool(
      _name: string,
      _config: object,
      registeredHandler: (
        input: unknown,
        context: { mcpReq: { _meta?: Record<string, unknown> } },
      ) => Promise<unknown>,
    ) {
      handler = registeredHandler
      return {}
    },
  } as unknown as McpServer
  scopeMcpToolCallers(server, {
    requestSession: () => ({
      kind: 'published',
      publication: { harness: 'claude-code', session: 'published-session' },
    }),
  })
  const registerTool = server.registerTool as unknown as (
    name: string,
    config: object,
    registeredHandler: () => Promise<unknown>,
  ) => unknown
  registerTool('current_session', {}, async () => {
    await Promise.resolve()
    return classifyCaller(process.env)
  })

  const call = (sessionId: string) => handler?.({}, { mcpReq: { _meta: { sessionId } } })
  expect(await Promise.all([call('first'), call('second')])).toEqual([
    { kind: 'harness', harness: 'codex', session: 'first' },
    { kind: 'harness', harness: 'codex', session: 'second' },
  ])
})

test('an MCP call without a request or publication refuses instead of reading session env', async () => {
  const previous = process.env.CLAUDE_CODE_SESSION_ID
  let handler:
    | ((
        input: unknown,
        context: { mcpReq: { _meta?: Record<string, unknown> } },
      ) => Promise<unknown>)
    | undefined
  const server = {
    registerTool(
      _name: string,
      _config: object,
      registeredHandler: (
        input: unknown,
        context: { mcpReq: { _meta?: Record<string, unknown> } },
      ) => Promise<unknown>,
    ) {
      handler = registeredHandler
      return {}
    },
  } as unknown as McpServer

  try {
    process.env.CLAUDE_CODE_SESSION_ID = 'stale-environment-session'
    scopeMcpToolCallers(server, { requestSession: () => ({ kind: 'absent' }) })
    const registerTool = server.registerTool as unknown as (
      name: string,
      config: object,
      registeredHandler: () => Promise<unknown>,
    ) => unknown
    registerTool('current_session', {}, async () => classifyCaller(process.env))

    expect(() => handler?.({}, { mcpReq: {} })).toThrow(
      'no session id in the request and none published for this harness process; run /clear or start a new session so its SessionStart hook publishes one',
    )
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_SESSION_ID
    else process.env.CLAUDE_CODE_SESSION_ID = previous
  }
})

test('a worker MCP call without a request or publication does not refuse', async () => {
  const previous = process.env.BOTTEGA_DEPTH
  let handler:
    | ((
        input: unknown,
        context: { mcpReq: { _meta?: Record<string, unknown> } },
      ) => Promise<unknown>)
    | undefined
  const server = {
    registerTool(
      _name: string,
      _config: object,
      registeredHandler: (
        input: unknown,
        context: { mcpReq: { _meta?: Record<string, unknown> } },
      ) => Promise<unknown>,
    ) {
      handler = registeredHandler
      return {}
    },
  } as unknown as McpServer

  try {
    process.env.BOTTEGA_DEPTH = '1'
    scopeMcpToolCallers(server, {
      requestSession: () => {
        throw new Error('worker calls must not read a publication')
      },
    })
    const registerTool = server.registerTool as unknown as (
      name: string,
      config: object,
      registeredHandler: () => Promise<unknown>,
    ) => unknown
    registerTool('current_session', {}, async () => classifyCaller(process.env))

    expect(await handler?.({}, { mcpReq: {} })).toEqual({ kind: 'worker' })
  } finally {
    if (previous === undefined) delete process.env.BOTTEGA_DEPTH
    else process.env.BOTTEGA_DEPTH = previous
  }
})
