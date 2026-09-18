import type { SecurityRunner } from '../../../shared/record-session.ts'

const RUNNER_KEY = Symbol.for('orch.security-runner')
const bytes = (value = '') => new TextEncoder().encode(value)
const result = (exitCode: number, stdout = '', stderr = '') => ({
  exitCode,
  stdout: bytes(stdout),
  stderr: bytes(stderr),
})

export function installRecordSessionRunner(runner: SecurityRunner | null): void {
  const holder = globalThis as typeof globalThis & { [RUNNER_KEY]?: SecurityRunner }
  if (runner) holder[RUNNER_KEY] = runner
  else delete holder[RUNNER_KEY]
}

export function memoryRecordSession(): {
  runner: SecurityRunner
  token(): string | null
  setToken(value: string | null): void
} {
  let stored: string | null = null
  const runner: SecurityRunner = (argv, stdin) => {
    const operation = argv[1]
    if (operation === 'find-generic-password') {
      return stored ? result(0, `${stored}\n`) : result(44, '', 'not found')
    }
    if (operation === 'add-generic-password') {
      const text = stdin ? new TextDecoder().decode(stdin) : ''
      stored = text.split('\n')[0] || null
      return result(0)
    }
    if (operation === 'delete-generic-password') {
      stored = null
      return result(0)
    }
    return result(1, '', 'unknown security operation')
  }
  return {
    runner,
    token: () => stored,
    setToken: (value) => {
      stored = value
    },
  }
}
