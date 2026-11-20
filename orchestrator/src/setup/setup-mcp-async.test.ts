import { afterEach, expect, mock, test } from 'bun:test'

let breach: 'deadline' | 'output' = 'deadline'
const execaMock = mock(async () => ({
  exitCode: null,
  stdout: '',
  stderr: '',
  isCanceled: false,
  timedOut: breach === 'deadline',
  isMaxBuffer: breach === 'output',
}))

mock.module('execa', () => ({ execa: execaMock }))

const { resultFailure, runSetupCommandAsync } = await import('./setup-mcp.ts')

afterEach(() => {
  breach = 'deadline'
  execaMock.mockClear()
})

test('async setup commands classify deadline breaches as timeouts', async () => {
  const result = await runSetupCommandAsync(['claude', 'mcp', 'get', 'bottega'])

  expect(result).toMatchObject({ timedOut: true, error: null })
  expect(resultFailure(result)).toBe('timed out')
})

test('async setup commands preserve output-limit breach detail', async () => {
  breach = 'output'

  const result = await runSetupCommandAsync(['claude', 'mcp', 'get', 'bottega'])

  expect(result).toMatchObject({ timedOut: false, error: 'output exceeded' })
  expect(resultFailure(result)).toBe('output exceeded')
})
