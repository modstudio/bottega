import { Database } from 'bun:sqlite'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  ensureMainStackStarted,
  MAIN_STACK_IDLE_STOP_AFTER_MS_DEFAULT,
  mainStackExecInProgress,
  mainStackIdleStopAfterMs,
  stopMainStackServices,
  sweepIdleMainStacks,
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
        projectId: 'project-42',
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
            ['docker', 'compose', 'ps'],
          ],
    )
  } finally {
    database.close()
  }
})

test('main stack release stops only services started by its ensure', () => {
  const { database, projectId } = mainStackTestDatabase()
  const calls: string[][] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    calls.push(args)
    return commandResult('')
  }) as typeof Bun.spawnSync)

  try {
    expect(
      stopMainStackServices({
        projectId,
        projectName: 'fixture',
        projectPath: '/registered/fixture',
        consumer: 'worktree-create',
        startedServices: ['redis'],
        database,
      }),
    ).toEqual({ outcome: 'stopped' })

    expect(calls).toEqual([
      ['docker', 'compose', 'ps', '--status', 'running', '-q'],
      ['docker', 'compose', 'stop', 'redis'],
    ])
  } finally {
    database.close()
  }
})

test('main stack release with no started services never invokes Compose', () => {
  const calls: string[][] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    calls.push(args)
    return commandResult('')
  }) as typeof Bun.spawnSync)

  expect(
    stopMainStackServices({
      projectId: 'unused',
      projectName: 'fixture',
      projectPath: '/registered/fixture',
      consumer: 'worktree-create',
      startedServices: [],
    }),
  ).toEqual({ outcome: 'none' })
  expect(calls).toEqual([])
})

test('main stack release leaves newly started services for idle sweep during a live session', () => {
  const { database, projectId } = mainStackTestDatabase()
  const now = new Date().toISOString()
  database
    .query(
      `INSERT INTO presence
       (session_id,harness,role,machine,project,project_record_id,cwd,first_seen,last_seen)
       VALUES ('architect','claude','architect','fixture','fixture',?,'/registered/fixture',?,?)`,
    )
    .run(projectId, now, now)
  const calls: string[][] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    calls.push(args)
    return commandResult('')
  }) as typeof Bun.spawnSync)

  try {
    const released = stopMainStackServices({
      projectId,
      projectName: 'fixture',
      projectPath: '/registered/fixture',
      consumer: 'worktree-create',
      startedServices: ['redis'],
      database,
    })

    expect(released.outcome).toBe('deferred')
    expect(released.detail).toContain('left running for the idle sweep')
    expect(released.detail).toContain('architect session is live')
    expect(calls).toEqual([['docker', 'compose', 'ps', '--status', 'running', '-q']])
  } finally {
    database.close()
  }
})

test('main stack ensure returns only newly started required services', () => {
  const database = new Database(':memory:')
  const commands: string[] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    const command = args.join(' ')
    commands.push(command)
    return commandResult(command.includes(' ps ') ? 'pgsql' : '')
  }) as typeof Bun.spawnSync)
  try {
    expect(
      ensureMainStackStarted({
        projectId: '',
        projectName: 'fixture',
        projectPath: '/registered/fixture',
        declaration: {
          consumers: ['worktree-create'],
          requiredServices: ['pgsql', 'redis'],
        },
        consumer: 'worktree-create',
        database,
      }),
    ).toEqual({ startedServices: ['redis'] })
    expect(commands).toEqual([
      'docker compose ps --status running --services pgsql redis',
      'docker compose up -d --wait pgsql redis',
    ])
  } finally {
    database.close()
  }
})

test.each([
  { name: 'empty exec lists', inspect: '[]\n[]', expected: false },
  { name: 'one non-empty exec list', inspect: '["exec-1"]', expected: true },
  { name: 'mixed container exec lists', inspect: '[]\n["exec-2"]\n[]', expected: true },
  { name: 'containers that never had an exec', inspect: 'null\nnull', expected: false },
  { name: 'a null list beside an active exec', inspect: 'null\n["exec-3"]', expected: true },
])('main stack command observation parses $name', (fixture) => {
  const ids = fixture.inspect.split('\n').map((_, index) => `container-${index + 1}`)
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) =>
    commandResult(
      args.includes('inspect') ? fixture.inspect : ids.join('\n'),
    )) as typeof Bun.spawnSync)

  expect(mainStackExecInProgress('/registered/fixture')).toEqual({ value: fixture.expected })
})

test.each([
  {
    name: 'failed inspect',
    inspectResult: { ...commandResult(''), exitCode: 1, stderr: Buffer.from('daemon unavailable') },
  },
  { name: 'garbled inspect', inspectResult: commandResult('not-json') },
])('main stack command observation reports unknown for $name', (fixture) => {
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) =>
    args.includes('inspect')
      ? fixture.inspectResult
      : commandResult('container-1')) as typeof Bun.spawnSync)

  expect(mainStackExecInProgress('/registered/fixture').value).toBe('unknown')
})

test('idle sweep reads project identity from a post-0117 store', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  const recordId = '01990000-0000-7000-8000-000000001214'
  database
    .query(
      "INSERT INTO project (record_id,name,path,settings) VALUES (?,'fixture','/registered/fixture','{}')",
    )
    .run(recordId)
  database
    .query(
      "INSERT INTO main_stack_activity (project_record_id,last_ensured_at) VALUES (?,'2020-01-01T00:00:00.000Z')",
    )
    .run(recordId)
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) =>
    commandResult(
      args[0] === 'docker' && args[1] === 'ps' && args.includes('--format')
        ? '/registered/fixture'
        : '',
    )) as typeof Bun.spawnSync)
  const errors: string[] = []
  const logs: string[] = []

  try {
    expect(
      sweepIdleMainStacks({
        database,
        projects: [
          {
            recordId,
            name: 'fixture',
            path: '/registered/fixture',
            stack: null,
            canon: true,
            retiredAt: null,
            settings: {},
          },
        ],
        dryRun: true,
        nowMs: Date.parse('2026-01-01T00:00:00.000Z'),
        log: (message) => logs.push(message),
        error: (message) => errors.push(message),
      }),
    ).toBe(false)
    expect(errors).toEqual([])
    expect(logs).toEqual(['would stop idle main stack for fixture'])
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

function mainStackTestDatabase(): { database: Database; projectId: string } {
  const database = new Database(':memory:')
  applyMigrations(database)
  const projectId = '01990000-0000-7000-8000-000000001435'
  database
    .query(
      "INSERT INTO project (record_id,name,path,settings) VALUES (?,'fixture','/registered/fixture','{}')",
    )
    .run(projectId)
  return { database, projectId }
}
