import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  CODEX_PERMISSION_PROFILE,
  codexPermissionProfileArgs,
  codexWritableRoots,
  decideCodexSandbox,
} from './codex-sandbox.ts'

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

describe('Codex permission profile', () => {
  const args = (network = false, writableRoots = ['/projects/own/tree', '/state/run/scratch']) =>
    codexPermissionProfileArgs({
      filesystem: {
        denyRead: ['/projects/sibling', '/state', '/projects/own/declared.secret'],
        allowRead: ['/projects/own/tree', '/state/run', '/runtime/assets'],
      },
      writableRoots,
      network,
    })

  test('maps the shared read profile and current writable roots', () => {
    expect(args()).toEqual([
      '-c',
      `default_permissions="${PLATFORM_SLUG}"`,
      '-c',
      `permissions.${PLATFORM_SLUG}.filesystem={":root"="read","/projects/own/tree"="write","/state/run"="read","/runtime/assets"="read","/state/run/scratch"="write","/projects/sibling"="deny","/state"="deny","/projects/own/declared.secret"="deny"}`,
    ])
  })

  test('read-only launches carry no write entry', () => {
    expect(args(false, []).join(' ')).not.toContain('"write"')
  })

  test('network is emitted only when the run enables it', () => {
    expect(args()).not.toContain(`permissions.${CODEX_PERMISSION_PROFILE}.network.enabled=true`)
    expect(args(true)).toContain(`permissions.${CODEX_PERMISSION_PROFILE}.network.enabled=true`)
  })
})
