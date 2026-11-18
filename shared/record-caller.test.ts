import { expect, test } from 'bun:test'
import { hostedAccessLogLine } from './hosted-server.ts'
import {
  CALLER_TOKEN_MAX_LENGTH,
  callerToken,
  loggedCallerToken,
  recordCallerToken,
} from './record-caller.ts'

test('caller token selects the scoped MCP caller before the process environment', () => {
  expect(callerToken('mcp:list_open_questions', 'hook:heartbeat')).toBe('mcp:list_open_questions')
  expect(callerToken(undefined, 'hook:session-brief')).toBe('hook:session-brief')
  expect(callerToken(undefined, undefined)).toBe('unknown')
})

test('caller token rejects unsafe and overlong values without truncating them', () => {
  expect(callerToken(undefined, 'cli:question/inbox')).toBe('cli:question/inbox')
  expect(callerToken(undefined, 'cli:question inbox')).toBe('unknown')
  expect(callerToken(undefined, 'x'.repeat(CALLER_TOKEN_MAX_LENGTH))).toBe(
    'x'.repeat(CALLER_TOKEN_MAX_LENGTH),
  )
  expect(callerToken(undefined, 'x'.repeat(CALLER_TOKEN_MAX_LENGTH + 1))).toBe('unknown')
})

test('record caller reads a changed process environment value on every request', () => {
  const environment = { BOTTEGA_CALLER: 'cli:first' }
  expect(recordCallerToken(environment)).toBe('cli:first')
  environment.BOTTEGA_CALLER = 'cli:second'
  expect(recordCallerToken(environment)).toBe('cli:second')
})

test('access-log caller validation prevents a supplied value from injecting a field', () => {
  const line = hostedAccessLogLine({
    method: 'GET',
    pathname: '/v1/questions',
    status: 200,
    durationMs: 1,
    caller: loggedCallerToken('cli:hook caller=hook:heartbeat'),
  })
  expect(line).toBe('GET /v1/questions 200 1ms caller=invalid')
  expect(line.match(/caller=/g)).toHaveLength(1)
})
