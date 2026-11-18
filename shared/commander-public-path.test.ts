import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { PLATFORM_SLUG } from './brand.ts'
import { applyPublicCommandPath, cliCallerEnvironmentValue } from './commander-public-path.ts'

test('CLI caller uses the resolved operator-visible leaf path and preserves a parent caller', () => {
  const root = new Command().name(PLATFORM_SLUG)
  const list = root.command('task').command('list')
  applyPublicCommandPath(root, ['task', 'list'], {
    ownerPath: ['task'],
    publicPath: ['task'],
  })

  expect(cliCallerEnvironmentValue(undefined, list)).toBe('cli:task/list')
  expect(cliCallerEnvironmentValue('hook:heartbeat', list)).toBe('hook:heartbeat')
})
