import { expect, test } from 'bun:test'
import { CALLER_TOKEN_MAX_LENGTH, callerToken, cliCallerEnvironmentValue } from './record-caller.ts'

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

test('CLI caller keeps a token supplied by its parent', () => {
  expect(cliCallerEnvironmentValue('hook:heartbeat', ['question', 'inbox'])).toBe('hook:heartbeat')
  expect(cliCallerEnvironmentValue(undefined, ['question', 'inbox'])).toBe('cli:question/inbox')
})
