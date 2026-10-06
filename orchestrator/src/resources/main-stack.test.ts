import { Database } from 'bun:sqlite'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import {
  ensureMainStackStarted,
  MAIN_STACK_IDLE_STOP_AFTER_MS_DEFAULT,
  mainStackIdleStopAfterMs,
} from './main-stack.ts'

afterEach(() => {
  mock.restore()
})

test('main stack idle threshold has a four-hour default and refuses invalid overrides', () => {
  expect(mainStackIdleStopAfterMs({})).toBe(MAIN_STACK_IDLE_STOP_AFTER_MS_DEFAULT)
  expect(mainStackIdleStopAfterMs({ ORCH_MAIN_STACK_IDLE_STOP_AFTER_MS: '5000' })).toBe(5_000)
  expect(() => mainStackIdleStopAfterMs({ ORCH_MAIN_STACK_IDLE_STOP_AFTER_MS: '0' })).toThrow(
    'ORCH_MAIN_STACK_IDLE_STOP_AFTER_MS',
  )
  expect(() => mainStackIdleStopAfterMs({ ORCH_MAIN_STACK_IDLE_STOP_AFTER_MS: 'later' })).toThrow(
    'ORCH_MAIN_STACK_IDLE_STOP_AFTER_MS',
  )
})

test.each([
  { name: 'confirmed', observed: 'db', requiredServices: ['db'] as string[] },
  { name: 'started', observed: '', requiredServices: undefined },
])('a successfully $name stack is not failed by unavailable activity storage', (fixture) => {
  const database = new Database(':memory:')
  const calls: string[][] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    calls.push(args)
    return commandResult(args.includes('ps') ? fixture.observed : '')
  }) as typeof Bun.spawnSync)

  try {
    expect(() =>
      ensureMainStackStarted({
        projectId: 42,
        projectName: 'fixture',
        projectPath: '/registered/fixture',
        declaration: {
          consumers: ['gate'],
          ...(fixture.requiredServices ? { requiredServices: fixture.requiredServices } : {}),
        },
        consumer: 'gate',
        database,
      }),
    ).not.toThrow()
    expect(calls.map((call) => call.slice(0, 3))).toEqual(
      fixture.name === 'confirmed'
        ? [['docker', 'compose', 'ps']]
        : [
            ['docker', 'compose', 'ps'],
            ['docker', 'compose', 'up'],
          ],
    )
  } finally {
    database.close()
  }
})

function commandResult(stdout: string): ReturnType<typeof Bun.spawnSync> {
  return {
    exitCode: 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(''),
    success: true,
    exitedDueToTimeout: false,
  } as ReturnType<typeof Bun.spawnSync>
}
