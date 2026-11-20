import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  CODEX_PERMISSION_PROFILE,
  codexPermissionProfileArgs,
  codexPermissionProfileInput,
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

test('repository writable roots include temporary directories once', () => {
  expect(
    codexWritableRoots('workspace-write', '/run/tree', ['/run/scratch'], '/private/tmp', true),
  ).toEqual(['/run/tree', '/run/scratch', '/tmp', '/private/tmp'])
  expect(codexWritableRoots('workspace-write', '/run/tree', ['/tmp'], '/tmp', true)).toEqual([
    '/run/tree',
    '/tmp',
  ])
  expect(codexWritableRoots('read-only', '/run/tree', [], '/tmp', true)).toBeNull()
  expect(codexWritableRoots('danger-full-access', '/run/tree', [], '/tmp', true)).toBeNull()
})

test('non-repository writable roots exclude shared temporary directories', () => {
  expect(
    codexWritableRoots(
      'workspace-write',
      '/run/isolate',
      ['/run/isolate/scratch'],
      '/private/tmp',
      false,
    ),
  ).toEqual(['/run/isolate', '/run/isolate/scratch'])
})

test('permission input gives readers exactly the shared write roots and preserves writer roots', () => {
  const profile = {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowUnixSockets: [],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: ['/state'],
      allowWithinDeny: ['/run'],
      allowWrite: ['/run/runtime', '/run/scratch'],
      denyWrite: [],
    },
  }
  const launch = {
    profile,
    sandbox: 'workspace-write' as const,
    cwd: '/run/tree',
    writableRoots: ['/run/scratch'],
    tempDir: '/private/tmp/codex-run',
  }

  expect(codexPermissionProfileInput({ ...launch, writesRepository: false }).writableRoots).toEqual(
    ['/run/runtime', '/run/scratch'],
  )
  expect(codexPermissionProfileInput({ ...launch, writesRepository: true }).writableRoots).toEqual([
    '/run/tree',
    '/run/scratch',
    '/tmp',
    '/private/tmp/codex-run',
  ])
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

  test('network is emitted only when the run enables it', () => {
    expect(args()).not.toContain(`permissions.${CODEX_PERMISSION_PROFILE}.network.enabled=true`)
    expect(args(true)).toContain(`permissions.${CODEX_PERMISSION_PROFILE}.network.enabled=true`)
  })
})
