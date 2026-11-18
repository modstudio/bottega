import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { PLATFORM_SLUG } from './brand.ts'
import { applyPublicCommandPath, cliCallerEnvironmentValue } from './commander-public-path.ts'

test('CLI caller uses the resolved operator-visible leaf path and preserves a parent caller', () => {
  const root = new Command().name(PLATFORM_SLUG)
  const lease = root.command('lease')
  applyPublicCommandPath(root, ['lease'], {
    ownerPath: ['lease'],
    publicPath: ['machine', 'lease'],
  })

  expect(cliCallerEnvironmentValue(undefined, lease)).toBe('cli:machine/lease')
  expect(cliCallerEnvironmentValue('hook:heartbeat', lease)).toBe('hook:heartbeat')
})
