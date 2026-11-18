import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { PLATFORM_SLUG } from './brand.ts'
import {
  applyPublicCommandPath,
  cliCallerEnvironmentValue,
  installCliCallerDispatch,
} from './commander-public-path.ts'
import { CALLER_ENVIRONMENT_KEY } from './record-caller.ts'

test('CLI caller uses the resolved operator-visible leaf path', () => {
  const root = new Command().name(PLATFORM_SLUG)
  const lease = root.command('lease')
  applyPublicCommandPath(root, ['lease'], {
    ownerPath: ['lease'],
    publicPath: ['machine', 'lease'],
  })

  expect(cliCallerEnvironmentValue('hook:heartbeat', lease)).toBe(
    'cli:machine/lease.hook:heartbeat',
  )
})

test('sequential in-process CLI dispatches restore the parent without stacking their path', async () => {
  const previous = process.env[CALLER_ENVIRONMENT_KEY]
  process.env[CALLER_ENVIRONMENT_KEY] = 'exec:run.cli:run/start'
  try {
    const program = new Command().name(PLATFORM_SLUG)
    const seen: string[] = []
    program
      .command('task')
      .command('show')
      .action(() => {
        seen.push(process.env[CALLER_ENVIRONMENT_KEY] ?? '')
      })
    const dispatch = installCliCallerDispatch(program)

    await dispatch(() => program.parseAsync(['task', 'show'], { from: 'user' }))
    await dispatch(() => program.parseAsync(['task', 'show'], { from: 'user' }))

    expect(seen).toEqual([
      'cli:task/show.exec:run.cli:run/start',
      'cli:task/show.exec:run.cli:run/start',
    ])
    expect(process.env[CALLER_ENVIRONMENT_KEY]).toBe('exec:run.cli:run/start')
  } finally {
    if (previous === undefined) delete process.env[CALLER_ENVIRONMENT_KEY]
    else process.env[CALLER_ENVIRONMENT_KEY] = previous
  }
})
