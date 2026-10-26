import { describe, expect, test } from 'bun:test'
import { McpHeadersHelperError } from '../mcp/mcp-headers-helper.ts'
import { classifyHubTaskLookup, trackerLookupFailureCondition } from './task-key-lookup.ts'

describe('built-in task-key lookup output', () => {
  test('classifies hub exact not-found output as established absence', () => {
    expect(classifyHubTaskLookup('DEV-99999', 1, '', 'no task DEV-99999\n')).toEqual({
      state: 'not-found',
    })
  })

  test('does not infer absence from other failed output', () => {
    expect(classifyHubTaskLookup('DEV-99999', 1, '', 'tracker database is unavailable\n')).toEqual({
      state: 'unreachable',
      condition: 'tracker database is unavailable',
    })
  })

  test('redacts an MCP environment credential from a thrown lookup error', () => {
    const credential = 'sentinel-environment-credential'
    const condition = trackerLookupFailureCondition(new Error(`remote rejected ${credential}`), {
      name: 'fixture',
      env: { TRACKER_TOKEN: credential },
    })

    expect(condition).toBe('tracker lookup failed: remote rejected [redacted]')
    expect(condition).not.toContain(credential)
  })

  test('names a headers helper refusal instead of reporting generic tracker failure', () => {
    const message = 'MCP server "fixture" headersHelper "./headers fixture" exited with code 7'
    expect(
      trackerLookupFailureCondition(new McpHeadersHelperError(message), {
        name: 'fixture',
        headersHelper: './headers fixture',
      }),
    ).toBe(message)
  })
})
