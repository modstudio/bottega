import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RECORD_API_ORIGIN } from '../../../shared/brand.ts'
import { setMachineValue } from '../../../shared/machine-config.ts'
import {
  type CommandCapture,
  classifySetupFacts,
  gatherKeystoreSetupFact,
  type HarnessName,
  KNOWN_HARNESSES,
} from './setup-facts.ts'

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

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
    machineLevel: null,
    recordApiUrl: RECORD_API_ORIGIN,
    recordApiConfigured: false,
    platform: 'linux',
    arch: 'x64',
    procVersion: 'Linux version 6.1.0-microsoft-standard-WSL2',
    bun: { path: '/bin/bun', version: '1.3.0' },
    git: { path: '/bin/git', version: command('git version 2.51.0') },
    gh: { path: '/bin/gh', version: command('gh version 2.80.0'), auth: command('', 0) },
    harnesses,
    localModelHost: { ok: false, detail: 'unset' },
    sandboxRuntime: {
      available: false,
      location: '/runtime',
      missingSystemDependencies: [],
      remedy: 'reinstall the sandbox runtime at /runtime, then retry',
    },
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

test('gathers the keystore value, source, and injected Linux probe result', () => {
  const root = mkdtempSync(join(tmpdir(), 'setup-keystore-fact-'))
  temporary.push(root)
  const env = { BOTTEGA_CONFIG_HOME: root }
  expect(gatherKeystoreSetupFact(env, 'linux', () => {})).toEqual({
    value: 'keychain',
    source: { kind: 'default' },
    keychainUsable: true,
  })

  setMachineValue('machine.keystore', 'file', env)
  expect(
    gatherKeystoreSetupFact(env, 'linux', () => {
      throw new Error('locked')
    }),
  ).toEqual({
    value: 'file',
    source: { kind: 'machine-file' },
    keychainUsable: false,
  })
  expect(gatherKeystoreSetupFact(env, 'darwin', () => {})).toEqual({
    value: 'file',
    source: { kind: 'machine-file' },
    keychainUsable: null,
  })
})
