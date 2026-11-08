import { expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import { registerEmbeddedAssets } from '../../../shared/embedded-assets.ts'
import { recordTunnelFailure, recordTunnelUnconfiguredRemedy } from './record-tunnel-error.ts'

test('a configured record tunnel adds its name and kickstart remedy to connection failures', () => {
  expect(
    recordTunnelFailure('Failed to connect', {
      tunnelApp: 'record-app',
      requiresTunnel: true,
    }),
  ).toBe(
    'Failed to connect\nrecord tunnel com.user.record-tunnel is unavailable; run launchctl kickstart -k gui/$(id -u)/com.user.record-tunnel',
  )
})

test('non-connection failures are unchanged', () => {
  expect(
    recordTunnelFailure('permission denied', {
      tunnelApp: 'record-app',
      requiresTunnel: true,
    }),
  ).toBe('permission denied')
})

test('a tunnel deploy adds its unconfigured remedy when the app is empty', () => {
  expect(recordTunnelFailure('Failed to connect', { tunnelApp: '', requiresTunnel: true })).toBe(
    `Failed to connect\nrecord tunnel is unconfigured; run ${PLATFORM_SLUG} machine config set --machine record.tunnel_app <fly-app>, then re-run ops/install.sh to install com.user.record-tunnel`,
  )
})

test('a non-tunnel record path keeps connection failures unchanged when the app is empty', () => {
  expect(recordTunnelFailure('Failed to connect', { tunnelApp: '', requiresTunnel: false })).toBe(
    'Failed to connect',
  )
})

test('a distribution remedy names machine setup instead of the checkout installer', () => {
  registerEmbeddedAssets({
    assets: {},
    files: {},
    manifest: {
      name: PLATFORM_NAME,
      version: '1.2.3',
      built: '2026-11-08T00:00:00.000Z',
      commit: 'abcdef',
    },
  })
  try {
    expect(recordTunnelUnconfiguredRemedy()).toContain(
      `then re-run ${PLATFORM_SLUG} machine setup apply to install com.user.record-tunnel`,
    )
  } finally {
    registerEmbeddedAssets(null)
  }
})
