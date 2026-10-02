import { describe, expect, test } from 'bun:test'
import { decideCodexSandbox } from './run-codex-sandbox.ts'

describe('Codex sandbox decision', () => {
  test('a repository sandbox never opens network access for Docker', () => {
    expect(decideCodexSandbox({ readsRepo: true })).toEqual({
      sandbox: 'workspace-write',
      workspaceWriteNetworkAccess: false,
    })
  })

  test('a no-repository job can write inside its isolated workspace without network access', () => {
    expect(decideCodexSandbox({ readsRepo: false })).toEqual({
      sandbox: 'workspace-write',
      workspaceWriteNetworkAccess: false,
    })
  })
})
