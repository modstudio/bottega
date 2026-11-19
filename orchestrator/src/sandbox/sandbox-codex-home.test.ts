import { expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MCP_SERVER_NAME, WORKER_MCP_SERVER_NAME } from '../../../shared/brand.ts'
import { prepareCodexHome, prepareSandboxHome, withoutRegisteredOrchAskServer } from './sandbox.ts'

test('prepares one persistent Codex home per chain without operator canon or sessions', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-codex-home-'))
  try {
    const source = join(fixture, 'operator-codex')
    const runDir = join(fixture, 'sandbox-41')
    mkdirSync(join(source, 'rules'), { recursive: true })
    mkdirSync(join(source, 'sessions'))
    writeFileSync(join(source, 'auth.json'), '{}')
    const config = 'model = """\nfixture\nproject_doc_max_bytes = 4096\n"""\n'
    writeFileSync(join(source, 'config.toml'), config)
    writeFileSync(join(source, 'AGENTS.md'), 'Operator canon.')
    writeFileSync(join(source, 'rules', 'default.rules'), 'allow')

    const first = prepareCodexHome(runDir, { HOME: fixture, CODEX_HOME: source })
    expect(first).toEqual({ CODEX_HOME: join(runDir, 'codex') })
    expect(lstatSync(join(first.CODEX_HOME!, 'auth.json')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(first.CODEX_HOME!, 'auth.json'))).toBe(join(source, 'auth.json'))
    expect(readFileSync(join(first.CODEX_HOME!, 'config.toml'), 'utf8')).toBe(config)
    expect(statSync(runDir).mode & 0o777).toBe(0o700)
    expect(statSync(first.CODEX_HOME!).mode & 0o777).toBe(0o700)
    expect(statSync(join(first.CODEX_HOME!, 'config.toml')).mode & 0o777).toBe(0o600)
    for (const omitted of ['AGENTS.md', 'AGENTS.override.md', 'rules', 'sessions']) {
      expect(existsSync(join(first.CODEX_HOME!, omitted))).toBe(false)
    }

    writeFileSync(join(source, 'config.toml'), 'model = "changed-after-first-turn"\n')
    chmodSync(runDir, 0o755)
    chmodSync(first.CODEX_HOME!, 0o755)
    const resumed = prepareSandboxHome(
      'codex',
      runDir,
      { HOME: fixture, CODEX_HOME: source },
      'host',
    )
    expect(resumed).toEqual(first)
    expect(readFileSync(join(resumed.CODEX_HOME!, 'config.toml'), 'utf8')).toBe(config)
    expect(statSync(runDir).mode & 0o777).toBe(0o700)
    expect(statSync(resumed.CODEX_HOME!).mode & 0o777).toBe(0o700)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test(`removes registered ${WORKER_MCP_SERVER_NAME} tables from Codex config and keeps neighboring tables`, () => {
  const config =
    `model = "codex"\n[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "orch"\n` +
    `[mcp_servers.${WORKER_MCP_SERVER_NAME}]\ncommand = "/old/bun"\n` +
    `[mcp_servers.${WORKER_MCP_SERVER_NAME}.env]\nSTALE = "1"\n` +
    '[[marketplace.sources]]\nurl = "kept"\n[ui]\nnotifications = true\n'
  expect(withoutRegisteredOrchAskServer(config)).toBe(
    `model = "codex"\n[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "orch"\n` +
      '[[marketplace.sources]]\nurl = "kept"\n[ui]\nnotifications = true\n',
  )
})

test(`leaves Codex config without a registered ${WORKER_MCP_SERVER_NAME} table unchanged`, () => {
  const config = `model = "codex"\r\n[mcp_servers.${MCP_SERVER_NAME}]\r\ncommand = "orch"\r\n`
  expect(withoutRegisteredOrchAskServer(config)).toBe(config)
})

test(`prepares Codex home without a user-registered ${WORKER_MCP_SERVER_NAME} server`, () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-codex-ask-config-'))
  try {
    const source = join(fixture, 'operator-codex')
    const runDir = join(fixture, 'run')
    mkdirSync(source)
    writeFileSync(join(source, 'auth.json'), '{}')
    writeFileSync(
      join(source, 'config.toml'),
      `[mcp_servers.${WORKER_MCP_SERVER_NAME}]\ncommand = "/old/bun"\n[mcp_servers.${WORKER_MCP_SERVER_NAME}.env]\nSTALE = "1"\n[ui]\nnotifications = true\n`,
    )

    const prepared = prepareCodexHome(runDir, { CODEX_HOME: source })

    expect(readFileSync(join(prepared.CODEX_HOME!, 'config.toml'), 'utf8')).toBe(
      '[ui]\nnotifications = true\n',
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('prepares Codex home with an empty config when the operator config is absent', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-codex-no-config-'))
  try {
    const source = join(fixture, 'operator-codex')
    const runDir = join(fixture, 'run')
    mkdirSync(source)
    writeFileSync(join(source, 'auth.json'), '{}')

    const prepared = prepareCodexHome(runDir, { CODEX_HOME: source })
    const config = join(prepared.CODEX_HOME!, 'config.toml')

    expect(readFileSync(config, 'utf8')).toBe('')
    expect(statSync(config).mode & 0o777).toBe(0o600)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('Codex home refuses a missing credential with a login remedy', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-codex-auth-'))
  try {
    expect(() => prepareCodexHome(join(fixture, 'run'), { HOME: fixture })).toThrow(
      `Codex worker home refusal: ${join(fixture, '.codex', 'auth.json')} is absent; run codex login for that home and retry`,
    )
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('Codex home refuses a symlinked config without changing its target', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'orch-codex-config-symlink-'))
  try {
    const source = join(fixture, 'operator-codex')
    const runDir = join(fixture, 'run')
    const target = join(fixture, 'outside.toml')
    mkdirSync(source)
    mkdirSync(join(runDir, 'codex'), { recursive: true })
    writeFileSync(join(source, 'auth.json'), '{}')
    writeFileSync(join(source, 'config.toml'), 'model = "operator"\n')
    writeFileSync(target, 'must stay unchanged\n')
    symlinkSync(target, join(runDir, 'codex', 'config.toml'))

    expect(() => prepareCodexHome(runDir, { CODEX_HOME: source })).toThrow(
      `Codex worker home refusal: ${join(runDir, 'codex', 'config.toml')} is not a regular non-symlink file owned by this user; remove the run's Codex home and retry`,
    )
    expect(readFileSync(target, 'utf8')).toBe('must stay unchanged\n')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
