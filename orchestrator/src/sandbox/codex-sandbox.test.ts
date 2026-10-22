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
  expect(codexWritableRoots('/run/tree', ['/run/scratch'], '/private/tmp')).toEqual([
    '/run/tree',
    '/run/scratch',
    '/tmp',
    '/private/tmp',
  ])
  expect(codexWritableRoots('/run/tree', ['/tmp'], '/tmp')).toEqual(['/run/tree', '/tmp'])
})
