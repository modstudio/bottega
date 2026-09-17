import { describe, expect, test } from 'bun:test'
import {
  type AgentAuthCapture,
  classifyAgentAuth,
  doctorAgentStatus,
  runAgentAuthCheck,
} from './agent-auth.ts'

const capture = (overrides: Partial<AgentAuthCapture> = {}): AgentAuthCapture => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  error: null,
  ...overrides,
})

describe('agent auth classification', () => {
  test('codex uses login-status exit codes', () => {
    expect(classifyAgentAuth('codex', capture({ exitCode: 1 }))).toEqual({
      status: 'signed-out',
      detail: 'not logged in',
    })
    expect(classifyAgentAuth('codex', capture({ stdout: 'Logged in using ChatGPT\n' }))).toEqual({
      status: 'ready',
      detail: 'stored login found; not verified with the server',
    })
  })

  test('grok uses only the first stdout line', () => {
    expect(
      classifyAgentAuth(
        'grok',
        capture({
          stdout: 'You are not authenticated.\nsecret-looking later output',
        }),
      ),
    ).toEqual({ status: 'signed-out', detail: 'not authenticated' })
    expect(
      classifyAgentAuth(
        'grok',
        capture({
          stdout: 'You are logged in with grok.com.\nignored later output',
        }),
      ),
    ).toEqual({
      status: 'ready',
      detail: 'stored login found; not verified with the server',
    })
    expect(classifyAgentAuth('grok', capture({ stdout: 'A new vendor message\n' }))).toEqual({
      status: 'unknown',
      detail: 'auth check output was not recognised',
    })
  })

  test('timeouts and spawn errors are unknown', () => {
    expect(classifyAgentAuth('codex', capture({ timedOut: true }))).toEqual({
      status: 'unknown',
      detail: 'auth check timed out',
    })
    expect(classifyAgentAuth('codex', capture({ error: 'ENOENT' }))).toEqual({
      status: 'unknown',
      detail: 'auth check could not run',
    })
  })

  test('an agent without a strategy keeps the existing doctor status without spawning', () => {
    const noSpawn = () => {
      throw new Error('must not spawn')
    }
    expect(runAgentAuthCheck('agy', 'agy', noSpawn)).toBeNull()
    expect(doctorAgentStatus('agy', null, 'agy', runAgentAuthCheck)).toEqual({
      status: 'ready',
      detail: '',
    })
  })

  test('the runner uses the strategy command, a hard timeout, and only grok first-line output', () => {
    const invocations: { argv: string[]; timeout: number }[] = []
    const fakeSpawn = (
      argv: string[],
      options: { stdout: 'pipe'; stderr: 'pipe'; timeout: number },
    ) => {
      invocations.push({ argv, timeout: options.timeout })
      return {
        exitCode: 0,
        stdout: new TextEncoder().encode('You are logged in with grok.com.\nprivate later output'),
        stderr: new Uint8Array(),
      }
    }
    expect(runAgentAuthCheck('grok', 'grok-fixture', fakeSpawn)).toEqual({
      status: 'ready',
      detail: 'stored login found; not verified with the server',
    })
    expect(invocations).toEqual([{ argv: ['grok-fixture', 'models'], timeout: 3_000 }])
  })
})
