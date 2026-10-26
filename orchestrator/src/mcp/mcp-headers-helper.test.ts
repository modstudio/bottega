import { expect, test } from 'bun:test'
import {
  effectiveMcpHeaders,
  type McpHeadersConfig,
  McpHeadersHelperError,
} from './mcp-headers-helper.ts'

const config: McpHeadersConfig = {
  name: 'starship',
  url: 'https://example.test/mcp',
  headersHelper: '/secret/helper starship',
  headers: { Authorization: 'static', Accept: 'application/json' },
}

test('dynamic headers override static headers case-insensitively', () => {
  expect(effectiveMcpHeaders(config, '{"authorization":"dynamic","X-Trace":"trace"}')).toEqual({
    Accept: 'application/json',
    authorization: 'dynamic',
    'X-Trace': 'trace',
  })
})

test('an empty helper object leaves static headers intact', () => {
  expect(effectiveMcpHeaders(config, '{}')).toEqual(config.headers!)
})

test('helper output that is not JSON is refused without carrying stdout', () => {
  const stdout = 'secret-token-that-must-not-escape'
  expect(() => effectiveMcpHeaders(config, stdout)).toThrow(McpHeadersHelperError)
  try {
    effectiveMcpHeaders(config, stdout)
  } catch (error) {
    expect(String((error as Error).message)).toContain('did not print JSON')
    expect(String((error as Error).message)).not.toContain(stdout)
  }
})

test('a non-string helper header value is refused without carrying stdout', () => {
  const stdout = '{"Authorization":42}'
  expect(() => effectiveMcpHeaders(config, stdout)).toThrow('non-string value')
  try {
    effectiveMcpHeaders(config, stdout)
  } catch (error) {
    expect(String((error as Error).message)).not.toContain(stdout)
  }
})
