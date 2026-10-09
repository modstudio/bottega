import { describe, expect, test } from 'bun:test'
import { decideCodexSandbox } from './codex-sandbox.ts'

describe('Codex sandbox decision', () => {
  test('workspace-write never opens network access for Docker', () => {
    expect(decideCodexSandbox()).toEqual({
      sandbox: 'workspace-write',
      workspaceWriteNetworkAccess: false,
    })
  })
})
