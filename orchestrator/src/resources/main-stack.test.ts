import { Database } from 'bun:sqlite'
import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { applyMigrations } from '../database/migrations.ts'
import type { Project } from '../project/projects.ts'
import {
  ensureMainStackStarted,
  MAIN_STACK_IDLE_STOP_AFTER_MS_DEFAULT,
  mainStackExecInProgress,
  mainStackIdleStopAfterMs,
  mainStackServedWorktree,
  stopMainStackServices,
  sweepIdleMainStacks,
} from './main-stack.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  mock.restore()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A registered checkout whose worktrees directory holds one provisioned worktree. */
function servedWorktreeFixture(): { root: string; checkout: string; worktree: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orch-main-stack-')))
  temporaryDirectories.push(root)
  const checkout = join(root, 'checkout')
  const worktree = join(checkout, '.claude', 'worktrees', 'STAR-5773')
  mkdirSync(worktree, { recursive: true })
  return { root, checkout, worktree }
}

const SERVED_WORKTREE_INVENTORY = [
  'docker',
  'ps',
  '--format',
  '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}',
]
const COMPOSE_RUNNING_CONTAINERS = ['docker', 'compose', 'ps', '--status', 'running', '-q']

test('main stack idle threshold has a four-hour default and refuses invalid overrides', () => {
  expect(mainStackIdleStopAfterMs({})).toBe(MAIN_STACK_IDLE_STOP_AFTER_MS_DEFAULT)
  expect(mainStackIdleStopAfterMs({ BOTTEGA_MAIN_STACK_IDLE_STOP_AFTER_MS: '5000' })).toBe(5_000)
  expect(() => mainStackIdleStopAfterMs({ BOTTEGA_MAIN_STACK_IDLE_STOP_AFTER_MS: '0' })).toThrow(
    'BOTTEGA_MAIN_STACK_IDLE_STOP_AFTER_MS',
  )
  expect(() =>
    mainStackIdleStopAfterMs({ BOTTEGA_MAIN_STACK_IDLE_STOP_AFTER_MS: 'later' }),
  ).toThrow('BOTTEGA_MAIN_STACK_IDLE_STOP_AFTER_MS')
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
      COMPOSE_RUNNING_CONTAINERS,
      SERVED_WORKTREE_INVENTORY,
      ['docker', 'compose', 'stop', 'redis'],
    ])
  } finally {
    database.close()
  }
})

test('main stack release keeps its services while a worktree of the project is served', () => {
  const { database, projectId } = mainStackTestDatabase()
  const { checkout, worktree } = servedWorktreeFixture()
  const calls: string[][] = []
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    calls.push(args)
    return commandResult(
      args[0] === 'docker' && args[1] === 'ps' ? `starship-worktree-STAR-5773\t${worktree}` : '',
    )
  }) as typeof Bun.spawnSync)

  try {
    const released = stopMainStackServices({
      projectId,
      projectName: 'fixture',
      projectPath: checkout,
      consumer: 'worktree-create',
      startedServices: ['redis'],
      database,
    })

    expect(released.outcome).toBe('deferred')
    expect(released.detail).toContain('a worktree of this project is served')
    expect(calls).toEqual([COMPOSE_RUNNING_CONTAINERS, SERVED_WORKTREE_INVENTORY])
  } finally {
    database.close()
  }
})

test('main stack release reports a leftover container instead of reading it as served', () => {
  const { database, projectId } = mainStackTestDatabase()
  const { checkout } = servedWorktreeFixture()
  const gone = join(checkout, '.claude', 'worktrees', 'STAR-1')
  const calls: string[][] = []
  const errors: string[] = []
  spyOn(console, 'error').mockImplementation(((message: string) => {
    errors.push(message)
  }) as typeof console.error)
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) => {
    calls.push(args)
    return commandResult(
      args[0] === 'docker' && args[1] === 'ps' ? `starship-worktree-STAR-1\t${gone}` : '',
    )
  }) as typeof Bun.spawnSync)

  try {
    const released = stopMainStackServices({
      projectId,
      projectName: 'fixture',
      projectPath: checkout,
      consumer: 'worktree-create',
      startedServices: ['redis'],
      database,
    })

    expect(released.outcome).toBe('stopped')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('leftover container starship-worktree-STAR-1')
    expect(errors[0]).toContain(`run ${PLATFORM_SLUG} machine sweep`)
    expect(calls).toEqual([
      COMPOSE_RUNNING_CONTAINERS,
      SERVED_WORKTREE_INVENTORY,
      ['docker', 'compose', 'stop', 'redis'],
    ])
  } finally {
    database.close()
  }
})

test('main stack release reports, not stops, when Docker cannot show a served worktree', () => {
  const { database, projectId } = mainStackTestDatabase()
  spyOn(Bun, 'spawnSync').mockImplementation(((args: string[]) =>
    args[0] === 'docker' && args[1] === 'ps'
      ? { ...commandResult(''), exitCode: 1, stderr: Buffer.from('daemon unavailable') }
      : commandResult('')) as typeof Bun.spawnSync)

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
    expect(released.detail).toContain('Docker could not show whether a worktree is served')
    expect(released.detail).toContain('daemon unavailable')
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
    expect(calls).toEqual([COMPOSE_RUNNING_CONTAINERS, SERVED_WORKTREE_INVENTORY])
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

test('served worktree observation recognizes a running worktree of the project', () => {
  const { checkout, worktree } = servedWorktreeFixture()
  spyOn(Bun, 'spawnSync').mockImplementation((() =>
    commandResult(
      `other-project-main\t/elsewhere/other\nstarship-worktree-STAR-5773\t${worktree}`,
    )) as typeof Bun.spawnSync)

  expect(mainStackServedWorktree({ checkoutPath: checkout })).toEqual({
    value: true,
    orphans: [],
  })
})

test('served worktree observation compares canonical paths, so an aliased checkout still matches', () => {
  const { root, checkout, worktree } = servedWorktreeFixture()
  // The register spells the checkout through a symlink; Compose recorded the real path.
  const alias = join(root, 'alias')
  symlinkSync(checkout, alias)
  spyOn(Bun, 'spawnSync').mockImplementation((() =>
    commandResult(`starship-worktree-STAR-5773\t${worktree}`)) as typeof Bun.spawnSync)

  expect(mainStackServedWorktree({ checkoutPath: alias })).toEqual({ value: true, orphans: [] })
})

test('served worktree observation recognizes a declared Compose project prefix', () => {
  spyOn(Bun, 'spawnSync').mockImplementation((() =>
    commandResult(
      `other-project-main\t/elsewhere/other\nstarship_wt_star_5773\t/elsewhere/starship`,
    )) as typeof Bun.spawnSync)

  expect(
    mainStackServedWorktree({
      checkoutPath: '/registered/starship',
      worktreeComposeProjectPrefix: 'starship_wt_',
    }),
  ).toEqual({ value: true, orphans: [] })
})

test('served worktree observation reports a container whose worktree directory is gone', () => {
  const { checkout } = servedWorktreeFixture()
  spyOn(Bun, 'spawnSync').mockImplementation((() =>
    commandResult(
      `starship-worktree-STAR-1\t${join(checkout, '.claude', 'worktrees', 'STAR-1')}`,
    )) as typeof Bun.spawnSync)

  expect(mainStackServedWorktree({ checkoutPath: checkout })).toEqual({
    value: false,
    orphans: ['starship-worktree-STAR-1'],
  })
})

test('served worktree observation does not infer a Compose prefix from the checkout name', () => {
  spyOn(Bun, 'spawnSync').mockImplementation((() =>
    commandResult('starship_wt_star_5773\t/elsewhere/starship')) as typeof Bun.spawnSync)

  expect(mainStackServedWorktree({ checkoutPath: '/registered/starship' })).toEqual({
    value: false,
    orphans: [],
  })
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
        ? args.some((arg) => arg.includes('\t'))
          ? ''
          : '/registered/fixture'
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

test('idle sweep keeps a stack while a declared prefix serves a worktree', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  const recordId = '01990000-0000-7000-8000-000000001539'
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
        ? args.some((arg) => arg.includes('\t'))
          ? 'starship_wt_star_5773\t/elsewhere/starship'
          : '/registered/fixture'
        : '',
    )) as typeof Bun.spawnSync)
  const errors: string[] = []
  const logs: string[] = []
  const sweep = (settings: Project['settings']) =>
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
          settings,
        },
      ],
      dryRun: true,
      nowMs: Date.parse('2026-01-01T00:00:00.000Z'),
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    })

  try {
    // A served worktree's stack runs Compose from the main checkout, so its Compose name
    // is the only identification Docker offers; the sweep must not stop the stack under it.
    expect(
      sweep({
        mainStack: { consumers: ['worktree-create'], worktreeComposeProjectPrefix: 'starship_wt_' },
      }),
    ).toBe(false)
    expect(logs).toEqual([])
    expect(errors).toEqual([])
    // The same inventory without the declaration is an idle stack, so the prefix is what
    // the guard acted on rather than the inventory having been ignored.
    expect(sweep({})).toBe(false)
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
