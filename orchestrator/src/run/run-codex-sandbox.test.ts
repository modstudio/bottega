import { describe, expect, test } from 'bun:test'
import { decideCodexSandbox } from './run-codex-sandbox.ts'

describe('Codex sandbox decision', () => {
  test('a repository sandbox never opens network access for Docker', () => {
    expect(decideCodexSandbox({ readsRepo: true })).toEqual({
      sandbox: 'workspace-write',
      workspaceWriteNetworkAccess: false,
    })
  })

  test('a no-repository job keeps the native read-only sandbox', () => {
    expect(decideCodexSandbox({ readsRepo: false })).toEqual({
      sandbox: 'read-only',
      workspaceWriteNetworkAccess: false,
    })
  })
})
