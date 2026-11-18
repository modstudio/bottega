import { expect, test } from 'bun:test'
import { Command } from 'commander'
import { PLATFORM_SLUG } from './brand.ts'
import {
  applyPublicCommandPath,
  cliCallerEnvironmentValue,
  installCliCallerDispatch,
} from './commander-public-path.ts'
import { CALLER_ENVIRONMENT_KEY, CALLER_TOKEN_MAX_LENGTH, callerToken } from './record-caller.ts'

test('CLI caller uses the resolved operator-visible leaf path and keeps caller lineage', () => {
  const root = new Command().name(PLATFORM_SLUG)
  const lease = root.command('lease')
  applyPublicCommandPath(root, ['lease'], {
    ownerPath: ['lease'],
    publicPath: ['machine', 'lease'],
  })

  expect(cliCallerEnvironmentValue(undefined, lease)).toBe('cli:machine/lease')
  expect(cliCallerEnvironmentValue('hook:heartbeat', lease)).toBe(
    'cli:machine/lease.hook:heartbeat',
  )
  expect(cliCallerEnvironmentValue('exec:run.cli:run/start', lease)).toBe(
    'cli:machine/lease.exec:run.cli:run/start',
  )

  const overLong = cliCallerEnvironmentValue(`exec:${'x'.repeat(CALLER_TOKEN_MAX_LENGTH)}`, lease)
  expect(overLong).toHaveLength(CALLER_TOKEN_MAX_LENGTH)
  expect(overLong.startsWith('cli:machine/lease.')).toBe(true)
  expect(callerToken(undefined, overLong)).toBe(overLong)
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
