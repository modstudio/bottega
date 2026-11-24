import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { WORKER_MCP_SERVER_NAME } from '../shared/brand.ts'
import { WORKER_READ_TOOLS } from '../shared/worker-read-tools.ts'
import { dispatchWorkerRecordRead, workerRecordReadCliRefusal } from './worker-record-read.ts'

const remedyCases = Object.entries(WORKER_READ_TOOLS).map(([route, tool]) => ({
  route: route as keyof typeof WORKER_READ_TOOLS,
  tool,
}))

test.each(remedyCases)(
  'codex worker CLI $route read refuses with the matching MCP remedy',
  ({ route, tool }) => {
    const invocation = {
      route,
      callerKind: 'worker',
      codexSandbox: true,
      hostedConfigured: true,
    } as const
    const refusal = workerRecordReadCliRefusal(invocation)
    expect(refusal).toContain(WORKER_MCP_SERVER_NAME)
    expect(refusal).toContain(tool)
    expect(refusal).not.toContain('record sign-in')
  },
)

test.each([
  {
    name: 'non-codex worker',
    callerKind: 'worker' as const,
    codexSandbox: false,
    hostedConfigured: true,
  },
  {
    name: 'non-worker',
    callerKind: 'operator' as const,
    codexSandbox: true,
    hostedConfigured: true,
  },
  {
    name: 'local-authoritative codex worker',
    callerKind: 'worker' as const,
    codexSandbox: true,
    hostedConfigured: false,
  },
])('$name uses the normal CLI path', ({ callerKind, codexSandbox, hostedConfigured }) => {
  expect(
    workerRecordReadCliRefusal({ route: 'task', callerKind, codexSandbox, hostedConfigured }),
  ).toBeNull()
})

const workerEnvironmentKeys = [
  'BOTTEGA_RUN_ID',
  'BOTTEGA_HOSTED_URL',
  'BOTTEGA_ASK_URL',
  'CODEX_SANDBOX',
] as const
let previousEnvironment: Record<(typeof workerEnvironmentKeys)[number], string | undefined>
let errorSpy: ReturnType<typeof spyOn>

beforeEach(() => {
  previousEnvironment = Object.fromEntries(
    workerEnvironmentKeys.map((key) => [key, process.env[key]]),
  ) as typeof previousEnvironment
  process.env.BOTTEGA_RUN_ID = 'worker-record-read-test'
  process.env.BOTTEGA_HOSTED_URL = 'https://record.example.test'
  delete process.env.BOTTEGA_ASK_URL
  process.env.CODEX_SANDBOX = 'seatbelt'
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  for (const key of workerEnvironmentKeys) {
    const value = previousEnvironment[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  errorSpy.mockRestore()
})

test.each([
  { argv: ['task', 'show', 'DEV-2618'], tool: WORKER_READ_TOOLS.task },
  { argv: ['task', 'doc', 'show', '1'], tool: WORKER_READ_TOOLS.document },
  { argv: ['task', 'document', 'show', '1'], tool: WORKER_READ_TOOLS.document },
  { argv: ['workflow', 'text', 'show', 'attached-text:id'], tool: WORKER_READ_TOOLS.workflow },
])('dispatch refuses worker route $argv with $tool', async ({ argv, tool }) => {
  expect(await dispatchWorkerRecordRead(argv)).toBe(1)
  expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(tool))
})

describe('outside the codex sandbox', () => {
  beforeEach(() => {
    delete process.env.CODEX_SANDBOX
  })

  test('dispatch leaves a worker without an ask URL on the normal CLI path', async () => {
    expect(await dispatchWorkerRecordRead(['task', 'show', 'DEV-2618'])).toBeNull()
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
