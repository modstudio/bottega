import { expect, test } from 'bun:test'
import { applySetupActions } from './setup-apply.ts'
import {
  type HarnessInstallDetector,
  installHarness,
  skippedHarnessInstall,
} from './setup-harness-install.ts'
import {
  HARNESS_INSTALL_TIMEOUT_MS,
  type HarnessInstallRoute,
  type SetupCommandResult,
} from './setup-mcp.ts'

const route: HarnessInstallRoute = { command: 'install fixture', binDir: '~/.local/bin' }
const success: SetupCommandResult = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  error: null,
}

function detector(path: string | null, files: string[] = []): HarnessInstallDetector {
  return { which: () => path, isFile: (candidate) => files.includes(candidate) }
}

test('reports an installed harness found on PATH and uses the install timeout', () => {
  const calls: Array<{ argv: string[]; timeoutMs: number }> = []
  const outcome = installHarness(
    'codex',
    route,
    (argv, timeoutMs) => {
      calls.push({ argv, timeoutMs })
      return success
    },
    detector('/usr/local/bin/codex'),
  )
  expect(calls).toEqual([
    { argv: ['/bin/sh', '-c', route.command], timeoutMs: HARNESS_INSTALL_TIMEOUT_MS },
  ])
  expect(outcome).toEqual({ status: 'applied', message: 'installed codex at /usr/local/bin/codex' })
})

test('reports the PATH fix when the harness is found only in its install directory', () => {
  const outcome = installHarness(
    'codex',
    route,
    () => success,
    detector(null, ['/home/operator/.local/bin/codex']),
    { HOME: '/home/operator' },
  )
  expect(outcome).toEqual({
    status: 'follow-up',
    message: 'installed codex at /home/operator/.local/bin/codex; add ~/.local/bin to PATH',
  })
})

test('reports a non-zero install with the exact manual command', () => {
  const outcome = installHarness(
    'codex',
    route,
    () => ({ ...success, exitCode: 7 }),
    detector(null),
  )
  expect(outcome.status).toBe('follow-up')
  expect(outcome.message).toContain('exit code 7')
  expect(outcome.message).toContain(route.command)
})

test('reports the last ten non-empty stdout and stderr lines in order', () => {
  const stdout = [
    'drop-1',
    '',
    'drop-2',
    ...Array.from({ length: 7 }, (_, index) => `out-${index}`),
  ].join('\n')
  const stderr = `\nerr-0\n\nerr-1\nerr-2\n`
  const outcome = installHarness(
    'codex',
    route,
    () => ({ ...success, exitCode: 1, stdout, stderr }),
    detector(null),
  )
  expect(outcome.message).not.toContain('drop-1')
  expect(outcome.message).not.toContain('drop-2')
  expect(outcome.message).toContain(
    [
      'drop-2',
      'out-0',
      'out-1',
      'out-2',
      'out-3',
      'out-4',
      'out-5',
      'out-6',
      'err-0',
      'err-1',
      'err-2',
    ]
      .slice(-10)
      .join('\n'),
  )
  expect(outcome.message).toEndWith(`; run by hand: ${route.command}`)
})

test('caps reported installer output at 2000 characters and keeps the end', () => {
  const outcome = installHarness(
    'codex',
    route,
    () => ({ ...success, exitCode: 1, stdout: `${'x'.repeat(2_050)}\nlast-error` }),
    detector(null),
  )
  expect(outcome.message).toContain('last-error')
  const appended = outcome.message.split('\n').slice(1).join('\n').split('; run by hand:')[0] ?? ''
  expect(appended).toHaveLength(2_000)
})

test('reports a timed-out install with the exact manual command', () => {
  const outcome = installHarness(
    'codex',
    route,
    () => ({ ...success, exitCode: null, timedOut: true }),
    detector(null),
  )
  expect(outcome.status).toBe('follow-up')
  expect(outcome.message).toContain('timed out')
  expect(outcome.message).toContain(route.command)
})

test('a skipped install reports the exact manual command and never runs a command', async () => {
  let calls = 0
  const expected = {
    status: 'follow-up',
    message: `codex was not installed: installation was skipped; run by hand: ${route.command}`,
  } as const
  expect(skippedHarnessInstall('codex', route)).toEqual(expected)
  const [result] = await applySetupActions(
    [{ kind: 'skip-harness-install', harness: 'codex', route }],
    { add: async () => {}, fillAbsent: async () => {} },
    {
      recordSessionPresent: () => false,
      migrateEnvironment: async () => ({ status: 'unchanged', message: null }),
    },
    () => {
      calls += 1
      return success
    },
  )
  expect(calls).toBe(0)
  expect(result).toMatchObject(expected)
})
