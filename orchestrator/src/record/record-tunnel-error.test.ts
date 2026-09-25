import { expect, test } from 'bun:test'
import { recordTunnelFailure } from './record-tunnel-error.ts'

test('a configured record tunnel adds its name and kickstart remedy to connection failures', () => {
  expect(recordTunnelFailure('Connection refused', 'record-app')).toBe(
    'Connection refused\nrecord tunnel com.user.record-tunnel is unavailable; run launchctl kickstart -k gui/$(id -u)/com.user.record-tunnel',
  )
})

test('non-connection failures are unchanged', () => {
  expect(recordTunnelFailure('permission denied', 'record-app')).toBe('permission denied')
})

test('connection failures are unchanged when no tunnel is configured', () => {
  expect(recordTunnelFailure('ECONNRESET', '')).toBe('ECONNRESET')
})
