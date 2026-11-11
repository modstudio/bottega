import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { PLATFORM_SLUG } from './brand.ts'

const SENTINEL = 'BOTTEGA_BOUNDED_PROCESS_ENV_SENTINEL'
const execaMock = mock(
  async (
    _file: string,
    _args: string[],
    options: { env?: Record<string, string | undefined>; extendEnv?: boolean },
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

const { startBounded, startParentBound } = await import('./bounded-process.ts')

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
