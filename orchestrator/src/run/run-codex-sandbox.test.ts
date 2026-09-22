import { describe, expect, test } from 'bun:test'
import { codexAcpReadonlyDockerRefusal, decideCodexSandbox } from './run-codex-sandbox.ts'

describe('Codex sandbox decision', () => {
  test('refuses flagged read-only Codex over ACP before it silently loses Docker', () => {
    expect(
      codexAcpReadonlyDockerRefusal({
        agentIsCodex: true,
        transport: 'acp',
        readsRepo: true,
        writesRepo: false,
        readonlyDocker: true,
        projectName: 'fixture',
      }),
    ).toBe(
      "project fixture declares worktree.readonly_docker, which needs Codex's command sandbox; run with --transport cli",
    )
  })

  test('allows CLI and combinations that do not need the read-only Docker ruling', () => {
    const flaggedReadOnly = {
      agentIsCodex: true,
      transport: 'acp',
      readsRepo: true,
      writesRepo: false,
      readonlyDocker: true,
      projectName: 'fixture',
    }
    for (const allowed of [
      { ...flaggedReadOnly, transport: 'cli' },
      { ...flaggedReadOnly, agentIsCodex: false },
      { ...flaggedReadOnly, readsRepo: false },
      { ...flaggedReadOnly, writesRepo: true },
      { ...flaggedReadOnly, readonlyDocker: false },
    ]) {
      expect(codexAcpReadonlyDockerRefusal(allowed)).toBeNull()
    }
  })

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
