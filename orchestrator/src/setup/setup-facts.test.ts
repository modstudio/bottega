import { expect, test } from 'bun:test'
import {
  type CommandCapture,
  classifySetupFacts,
  type HarnessName,
  KNOWN_HARNESSES,
} from './setup-facts.ts'

const command = (stdout: string, exitCode = 0): CommandCapture => ({
  exitCode,
  stdout,
  stderr: '',
  timedOut: false,
  error: null,
})

function facts(overrides: Partial<Parameters<typeof classifySetupFacts>[0]> = {}) {
  const harnesses = Object.fromEntries(
    KNOWN_HARNESSES.map((name) => [
      name,
      { path: `/bin/${name}`, version: command(`${name} 1.2.3`), auth: 'unknown' as const },
    ]),
  ) as Record<HarnessName, { path: string; version: CommandCapture; auth: 'unknown' }>
  return classifySetupFacts({
    platform: 'linux',
    arch: 'x64',
    procVersion: 'Linux version 6.1.0-microsoft-standard-WSL2',
    bun: { path: '/bin/bun', version: '1.3.0' },
    git: { path: '/bin/git', version: command('git version 2.51.0') },
    gh: { path: '/bin/gh', version: command('gh version 2.80.0'), auth: command('', 0) },
    harnesses,
    localModelHost: { ok: false, detail: 'unset' },
    sandboxRuntime: { available: false, location: '/runtime' },
    ...overrides,
  })
}

test('classifies missing binaries, versions, gh login, and WSL from captures', () => {
  const captured = facts({ git: { path: null, version: null } })
  expect(captured.os.wsl).toBe(true)
  expect(captured.git).toEqual({ path: null, version: null })
  expect(captured.gh).toEqual({ path: '/bin/gh', version: '2.80.0', loggedIn: true })
  expect(captured.harnesses.codex.version).toBe('1.2.3')

  expect(
    facts({ gh: { path: '/bin/gh', version: command('gh 2.80.0'), auth: command('', 1) } }).gh
      .loggedIn,
  ).toBe(false)
})

test('harnesses without an auth strategy remain unknown', () => {
  const captured = facts()
  expect(captured.harnesses.claude.auth).toBe('unknown')
  expect(captured.harnesses.opencode.auth).toBe('unknown')
  expect(captured.harnesses.goose.auth).toBe('unknown')
})
