import { expect, test } from 'bun:test'
import { WORKER_MCP_SERVER_NAME } from '../shared/brand.ts'
import { WORKER_READ_TOOLS } from '../shared/worker-read-tools.ts'
import { workerRecordReadCliRefusal } from './worker-record-read.ts'

const remedyCases = Object.entries(WORKER_READ_TOOLS).flatMap(([route, tool]) =>
  [false, true].map((askUrl) => ({
    route: route as keyof typeof WORKER_READ_TOOLS,
    tool,
    askUrl,
  })),
)

test.each(remedyCases)(
  'codex worker CLI $route read refuses with the matching MCP remedy when ask URL is $askUrl',
  ({ route, tool, askUrl }) => {
    const invocation = {
      route,
      callerKind: 'worker',
      codexSandbox: true,
      askUrl,
    } as const
    const refusal = workerRecordReadCliRefusal(invocation)
    expect(refusal).toContain(WORKER_MCP_SERVER_NAME)
    expect(refusal).toContain(tool)
    expect(refusal).not.toContain('record sign-in')
  },
)

test.each([
  { name: 'non-codex worker with an ask URL', callerKind: 'worker' as const, codexSandbox: false },
  { name: 'non-worker', callerKind: 'operator' as const, codexSandbox: true },
])('$name uses the normal CLI path', ({ callerKind, codexSandbox }) => {
  expect(workerRecordReadCliRefusal({ route: 'task', callerKind, codexSandbox })).toBeNull()
})
