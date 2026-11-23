import { expect, test } from 'bun:test'
import { workerRecordReadCliRefusal } from './worker-record-read.ts'

test('codex worker CLI reads refuse with the matching bottega-ask remedy', () => {
  for (const [route, tool] of [
    ['task', 'read_task'],
    ['document', 'read_task_document'],
    ['workflow', 'read_workflow_text'],
  ] as const) {
    const refusal = workerRecordReadCliRefusal({
      route,
      worker: true,
      codexSandbox: true,
      askUrl: false,
    })
    expect(refusal).toContain(`bottega-ask tool ${tool}`)
    expect(refusal).not.toContain('record sign-in')
  }
  expect(
    workerRecordReadCliRefusal({
      route: 'task',
      worker: true,
      codexSandbox: true,
      askUrl: true,
    }),
  ).toBeNull()
})
