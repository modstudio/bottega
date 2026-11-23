import { expect, test } from 'bun:test'
import { workerRecordReadCliRefusal } from './worker-record-read.ts'

test('codex worker CLI reads refuse with the matching ask MCP remedy', () => {
  for (const [route, tool] of [
    ['task', 'read_task'],
    ['document', 'read_task_document'],
    ['workflow', 'read_workflow_text'],
  ] as const) {
    const refusal = workerRecordReadCliRefusal({
      route,
      callerKind: 'worker',
      codexSandbox: true,
      askUrl: false,
    })
    expect(refusal).toContain(`MCP tool ${tool}`)
    expect(refusal).not.toContain('record sign-in')
  }
  expect(
    workerRecordReadCliRefusal({
      route: 'task',
      callerKind: 'worker',
      codexSandbox: true,
      askUrl: true,
    }),
  ).toBeNull()
  expect(
    workerRecordReadCliRefusal({
      route: 'task',
      callerKind: 'operator',
      codexSandbox: true,
      askUrl: false,
    }),
  ).toBeNull()
})
