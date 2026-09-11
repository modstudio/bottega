import { describe, expect, test } from 'bun:test'
import { effectiveMcpRequest } from './mcp-preflight.ts'

describe('effectiveMcpRequest', () => {
  const mcpJob = { needs: { mcp: true } }
  const nonMcpJob = { needs: {} }

  test('requires MCP when the job declares it and the caller omits a request', () => {
    expect(effectiveMcpRequest(undefined, mcpJob)).toBe(true)
  })

  test('preserves an explicit preferred request for an MCP job', () => {
    expect(effectiveMcpRequest('prefer', mcpJob)).toBe('prefer')
  })

  test('preserves an explicit required request for an MCP job', () => {
    expect(effectiveMcpRequest(true, mcpJob)).toBe(true)
  })

  test('leaves an omitted request absent for a non-MCP job', () => {
    expect(effectiveMcpRequest(undefined, nonMcpJob)).toBeUndefined()
  })

  test('preserves an explicit preferred request for a non-MCP job', () => {
    expect(effectiveMcpRequest('prefer', nonMcpJob)).toBe('prefer')
  })
})
