import { expect, test } from 'bun:test'
import {
  recordRequestHeaderViolations,
  THIRD_PARTY_BEARER_HEADER_FILES,
} from './check-record-request-headers.ts'

test('refuses request-header construction outside the shared helper', () => {
  const source = `
    const headers = new Headers()
    headers.set('x-record-space', destination)
    const init = { headers: { 'x-bottega-caller': caller } }
    const authorization = { authorization: \`Bearer \${token}\` }
  `
  expect(recordRequestHeaderViolations(source, 'hub/src/example.ts')).toEqual([
    { file: 'hub/src/example.ts', line: 3, kind: 'space' },
    { file: 'hub/src/example.ts', line: 4, kind: 'caller' },
    { file: 'hub/src/example.ts', line: 5, kind: 'bearer' },
  ])
})

test('allows server reads and the named third-party bearer clients', () => {
  const serverRead = `
    request.headers.get('x-record-space')
    request.headers.has('x-bottega-caller')
  `
  expect(recordRequestHeaderViolations(serverRead, 'orchestrator/src/server.ts')).toEqual([])
  expect(
    recordRequestHeaderViolations(
      `const init = { headers: { authorization: \`Bearer \${token}\` } }`,
      'hub/src/mcp.ts',
    ),
  ).toEqual([])
  expect(THIRD_PARTY_BEARER_HEADER_FILES['hub/src/mcp.ts']).toContain('external tracker MCP')
})
