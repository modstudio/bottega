import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'
import { BoundExceededError, CALL_BUDGETS } from './call-budgets.ts'

const SENTINEL = 'BOTTEGA_BOUNDED_PROCESS_ENV_SENTINEL'
const execaMock = mock(
  async (
    _file: string,
    _args: string[],
    options: {
      env?: Record<string, string | undefined>
      extendEnv?: boolean
      timeout?: number
    },
  ) => {
    const effectiveEnv =
      options.extendEnv === false ? options.env : { ...process.env, ...options.env }
    return {
      exitCode: 0,
      stdout: effectiveEnv?.[SENTINEL] ?? '',
      stderr: '',
      isCanceled: false,
      timedOut: false,
      isMaxBuffer: false,
    }
  },
)

mock.module('execa', () => ({ execa: execaMock }))

const {
  boundedDeadlineMs,
  isDeadlineBreach,
  parentBoundSignalExitCode,
  startBounded,
  startParentBound,
} = await import('./bounded-process.ts')

let previousSentinel: string | undefined

beforeEach(() => {
  previousSentinel = process.env[SENTINEL]
  process.env[SENTINEL] = 'from-parent'
})

afterEach(() => {
  if (previousSentinel === undefined) delete process.env[SENTINEL]
  else process.env[SENTINEL] = previousSentinel
  execaMock.mockClear()
})

test('an explicit environment replaces the parent environment', async () => {
  const env = { PATH: process.env.PATH }
  await startBounded(['bounded-process-env-probe'], {
    budget: 'process-table',
    env,
  })

  expect(execaMock.mock.calls[0]?.[2]).toMatchObject({ env, extendEnv: false })
})

test('a generic git budget is raised to the classified ref-move deadline', async () => {
  await startBounded(['git', 'pull'], { budget: 'git-plumbing' })

  expect(execaMock.mock.calls[0]?.[2]?.timeout).toBe(CALL_BUDGETS['git-ref-move'].deadlineMs)
})

test('a deliberate git probe budget keeps its declared deadline', async () => {
  await startBounded(['git', 'rev-parse'], { budget: 'git-probe' })

  expect(execaMock.mock.calls[0]?.[2]?.timeout).toBe(CALL_BUDGETS['git-probe'].deadlineMs)
})

test('named deadline helpers share the budget and distinguish output breaches', () => {
  expect(boundedDeadlineMs('setup-command')).toBe(CALL_BUDGETS['setup-command'].deadlineMs)
  expect(
    isDeadlineBreach(
      new BoundExceededError('probe', 'setup-command', 'deadline', boundedDeadlineMs('setup-command')),
    ),
  ).toBe(true)
  expect(
    isDeadlineBreach(
      new BoundExceededError('probe', 'setup-command', 'output', CALL_BUDGETS['setup-command'].outputBytes),
    ),
  ).toBe(false)
})

test('tracked child exit flags compose into the parent signal decision', () => {
  const cases: Array<{
    name: string
    signal: 'SIGINT' | 'SIGTERM'
    flags: boolean[]
    expected: number | null
  }> = [
    { name: 'no children exits', signal: 'SIGTERM', flags: [], expected: 143 },
    { name: 'one default child exits', signal: 'SIGTERM', flags: [true], expected: 143 },
    { name: 'only opted-out children wait', signal: 'SIGTERM', flags: [false], expected: null },
    { name: 'mixed children exit', signal: 'SIGTERM', flags: [false, true], expected: 143 },
    { name: 'SIGINT exits with its code', signal: 'SIGINT', flags: [], expected: 130 },
  ]
  for (const row of cases) {
    expect(parentBoundSignalExitCode(row.signal, row.flags), row.name).toBe(row.expected)
  }
})

test('a parent-bound child keeps all three relay pipes streaming', async () => {
  const originalSpawn = Bun.spawn
  const launches: unknown[][] = []
  const child = { exited: Promise.resolve(0), kill: () => {} } as unknown as ReturnType<
    typeof startParentBound
  >
  const executable = `/installed/${PLATFORM_SLUG}`
  Bun.spawn = ((...args: unknown[]) => {
    launches.push(args)
    return child
  }) as typeof Bun.spawn
  try {
    expect(
      startParentBound([executable, 'mcp', 'serve-child'], {
        name: 'MCP server child',
        cwd: '/work',
        env: { PATH: '/bin' },
      }),
    ).toBe(child)
    expect(launches).toEqual([
      [
        [executable, 'mcp', 'serve-child'],
        {
          cwd: '/work',
          env: { PATH: '/bin' },
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      ],
    ])
  } finally {
    Bun.spawn = originalSpawn
  }
})

test('a parent-bound child can inherit all three stdio streams', () => {
  const originalSpawn = Bun.spawn
  const launches: unknown[][] = []
  const child = { exited: Promise.resolve(0), kill: () => {} } as unknown as ReturnType<
    typeof startParentBound
  >
  Bun.spawn = ((...args: unknown[]) => {
    launches.push(args)
    return child
  }) as typeof Bun.spawn
  try {
    startParentBound([`/installed/${PLATFORM_SLUG}`, 'credential'], {
      name: 'credential child',
      inheritStdio: true,
    })
    expect(launches[0]?.[1]).toMatchObject({
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
  } finally {
    Bun.spawn = originalSpawn
  }
})
