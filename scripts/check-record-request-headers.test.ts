import { expect, test } from 'bun:test'
import { CALLER_HEADER_NAME } from '../shared/record-caller.ts'
import {
  recordFetchViolations,
  recordRequestHeaderViolations,
} from './check-record-request-headers.ts'

test('refuses request-header construction outside the shared helper', () => {
  const source = `
    const headers = new Headers()
    headers.set('x-record-space', destination)
    const init = { headers: { '${CALLER_HEADER_NAME}': caller } }
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
    request.headers.has('${CALLER_HEADER_NAME}')
  `
  expect(recordRequestHeaderViolations(serverRead, 'orchestrator/src/server.ts')).toEqual([])
  expect(
    recordRequestHeaderViolations(
      `const init = { headers: { authorization: \`Bearer \${token}\` } }`,
      'hub/src/mcp.ts',
    ),
  ).toEqual([])
})

test('refuses shared header-name identifiers in setter, computed-key, and tuple forms', () => {
  const source = `
    headers.set(CALLER_HEADER_NAME, caller)
    headers.append(RECORD_SPACE_HEADER_NAME, destination)
    const computed = { [CALLER_HEADER_NAME]: caller }
    const tuples = [[RECORD_SPACE_HEADER_NAME, destination]]
  `
  expect(recordRequestHeaderViolations(source, 'hub/src/example.ts')).toEqual([
    { file: 'hub/src/example.ts', line: 2, kind: 'caller' },
    { file: 'hub/src/example.ts', line: 3, kind: 'space' },
    { file: 'hub/src/example.ts', line: 4, kind: 'caller' },
    { file: 'hub/src/example.ts', line: 5, kind: 'space' },
  ])
})

test('refuses binary bearer construction', () => {
  const source = `const init = { headers: { authorization: 'Bearer ' + token } }`
  expect(recordRequestHeaderViolations(source, 'hub/src/example.ts')).toEqual([
    { file: 'hub/src/example.ts', line: 1, kind: 'bearer' },
  ])
})

test('allows a server read through the shared caller-header name', () => {
  expect(
    recordRequestHeaderViolations(
      `request.headers.get(CALLER_HEADER_NAME)`,
      'orchestrator/src/server.ts',
    ),
  ).toEqual([])
})

test('refuses direct record fetches and allows the traced seam', () => {
  expect(
    recordFetchViolations(
      `const response = await fetch(resolveRecordApiUrl())`,
      'hub/src/example.ts',
    ),
  ).toEqual([{ file: 'hub/src/example.ts', line: 1 }])
  expect(
    recordFetchViolations(
      `const response = await tracedRecordFetch(resolveRecordApiUrl(), {}, fetch)`,
      'hub/src/example.ts',
    ),
  ).toEqual([])
})

test('refuses hosted transports and opaque hosted-session sends', () => {
  const source = `
    const direct = hostedApiFetch(url)
    const transport = boundedFetch('hosted-api')
    const response = input.fetch(input.url, init)
  `
  expect(recordFetchViolations(source, 'hub/src/example.ts')).toEqual([
    { file: 'hub/src/example.ts', line: 2 },
    { file: 'hub/src/example.ts', line: 3 },
    { file: 'hub/src/example.ts', line: 4 },
  ])
})

test('refuses fallback fetches and resolver-derived URL variables', () => {
  const source = `
    async function send(options) {
      const url = resolveHostedUrl('/v1/tasks')
      await (options.fetch ?? fetch)(url, {})
      await (options.fetchImpl || fetch)(resolveRecordApiUrl('/v1/docs'), {})
    }
  `
  expect(recordFetchViolations(source, 'hub/src/example.ts')).toEqual([
    { file: 'hub/src/example.ts', line: 4 },
    { file: 'hub/src/example.ts', line: 5 },
  ])
})
