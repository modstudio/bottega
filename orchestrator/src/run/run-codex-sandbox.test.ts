import { describe, expect, test } from 'bun:test'
import { decideCodexSandbox } from './run-codex-sandbox.ts'

describe('Codex sandbox decision', () => {
  test('a flagged read-only repository opens Docker through workspace-write network access', () => {
    expect(
      decideCodexSandbox({
        agentIsCodex: true,
        readsRepo: true,
        writesRepo: false,
        readonlyDocker: true,
      }),
    ).toEqual({ sandbox: 'workspace-write', workspaceWriteNetworkAccess: true })
  })

  test('an absent flag preserves the bounded repository sandbox without network access', () => {
    expect(
      decideCodexSandbox({
        agentIsCodex: true,
        readsRepo: true,
        writesRepo: false,
        readonlyDocker: false,
      }),
    ).toEqual({ sandbox: 'workspace-write', workspaceWriteNetworkAccess: false })
  })

  test('the read-only Docker declaration does not affect writing or no-repository jobs', () => {
    expect(
      decideCodexSandbox({
        agentIsCodex: true,
        readsRepo: true,
        writesRepo: true,
        readonlyDocker: true,
      }),
    ).toEqual({
      sandbox: 'workspace-write',
      workspaceWriteNetworkAccess: false,
    })
    expect(
      decideCodexSandbox({
        agentIsCodex: true,
        readsRepo: false,
        writesRepo: false,
        readonlyDocker: true,
      }),
    ).toEqual({ sandbox: 'read-only', workspaceWriteNetworkAccess: false })
    expect(
      decideCodexSandbox({
        agentIsCodex: false,
        readsRepo: true,
        writesRepo: false,
        readonlyDocker: true,
      }).workspaceWriteNetworkAccess,
    ).toBe(false)
  })
})
