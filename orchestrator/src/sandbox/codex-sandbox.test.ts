import { describe, expect, test } from 'bun:test'
import { codexWritableRoots, decideCodexSandbox } from './codex-sandbox.ts'

describe('Codex sandbox decision', () => {
  test('workspace-write never opens network access for Docker', () => {
    expect(decideCodexSandbox()).toEqual({
      sandbox: 'workspace-write',
      workspaceWriteNetworkAccess: false,
    })
  })
})

test('native writable roots include temporary directories once', () => {
  expect(
    codexWritableRoots('workspace-write', '/run/tree', ['/run/scratch'], '/private/tmp'),
  ).toEqual(['/run/tree', '/run/scratch', '/tmp', '/private/tmp'])
  expect(codexWritableRoots('workspace-write', '/run/tree', ['/tmp'], '/tmp')).toEqual([
    '/run/tree',
    '/tmp',
  ])
  expect(codexWritableRoots('read-only', '/run/tree', [], '/tmp')).toBeNull()
  expect(codexWritableRoots('danger-full-access', '/run/tree', [], '/tmp')).toBeNull()
})
