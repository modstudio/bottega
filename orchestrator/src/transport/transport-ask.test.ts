import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bottegaEntryArgv } from '../../../shared/self-spawn.ts'
import { BUILTIN_AGENTS } from '../agent/agents.ts'
import type { TransportStartOpts } from './transport.ts'
import { configuredAcpAsk } from './transport-acp.ts'
import { configuredCliAsk } from './transport-cli.ts'

function opts(agent: TransportStartOpts['agent'], env: Record<string, string>): TransportStartOpts {
  return {
    agent,
    env,
    cwd: '/tmp',
    prompt: '',
    outPath: '/tmp/out',
    startedAt: 0,
  }
}

describe('configured orch-ask transport evidence', () => {
  test('CLI reports Codex from its scope definition and none for an unregistered agent', () => {
    const codex = BUILTIN_AGENTS.codex!
    expect(configuredCliAsk(opts(codex, {}))).toEqual(bottegaEntryArgv('ask-server'))
    expect(
      configuredCliAsk(opts({ ...codex, name: 'without-ask', askServerCommand: undefined }, {})),
    ).toBeNull()
  })

  test('CLI reports the Grok command read back from its existing home', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-grok-ask-'))
    try {
      mkdirSync(root, { recursive: true })
      writeFileSync(
        join(root, 'config.toml'),
        '[mcp_servers.orch-ask]\ncommand = "/stale/bun"\nargs = ["/stale/orch", "ask-server"]\n',
      )
      expect(configuredCliAsk(opts(BUILTIN_AGENTS.grok!, { GROK_HOME: root }))).toEqual([
        '/stale/bun',
        '/stale/orch',
        'ask-server',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('ACP reports exactly the orch-ask session server it would register', () => {
    const command = configuredAcpAsk(
      opts(BUILTIN_AGENTS.codex!, { ORCH_RUN_ID: '42', ORCH_RUN_TOKEN: 'token' }),
    )
    expect(command).toEqual(bottegaEntryArgv('ask-server'))
    expect(configuredAcpAsk(opts(BUILTIN_AGENTS.codex!, {}))).toBeNull()
  })

  test('ACP preserves Grok per-run-home registration instead of adding a session server', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-grok-acp-ask-'))
    try {
      writeFileSync(
        join(root, 'config.toml'),
        '[mcp_servers.orch-ask]\ncommand = "/old/bun"\nargs = ["/old/orch", "ask-server"]\n',
      )
      expect(
        configuredAcpAsk(
          opts(BUILTIN_AGENTS.grok!, {
            GROK_HOME: root,
            ORCH_RUN_ID: '42',
            ORCH_RUN_TOKEN: 'token',
          }),
        ),
      ).toEqual(['/old/bun', '/old/orch', 'ask-server'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
