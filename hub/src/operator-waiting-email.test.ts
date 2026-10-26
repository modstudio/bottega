import { expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../shared/brand.ts'
import type { OperatorWaitingItem } from '../../shared/orch-contract.ts'
import { deliverOperatorWaitingEmails, dueOperatorWaitingEmails } from './operator-waiting-email.ts'

const item = (patch: Partial<OperatorWaitingItem> = {}): OperatorWaitingItem => ({
  kind: 'question',
  id: 7,
  workflow_cursor_record_id: null,
  question_record_id: '00000000-0000-4000-8000-000000000007',
  run_number: 42,
  run_record_id: '00000000-0000-4000-8000-000000000042',
  project: PLATFORM_NAME.toLowerCase(),
  task_key: 'DEV-943',
  session_id: null,
  question: 'Which approach?',
  options: ['A', 'B'],
  recommendation: 'A',
  why: 'It is safer.',
  waiting_since: '2026-09-25T10:00:00.000Z',
  episode: 'episode-1',
  answer_command: `${PLATFORM_SLUG} question answer 42 --q7 --from-operator "<ruling>"`,
  ...patch,
})

test('due decision selects only overdue unpushed episodes and zero disables it', () => {
  const now = new Date('2026-09-25T11:00:00.000Z')
  expect(
    dueOperatorWaitingEmails(
      [item(), item({ id: 8, episode: 'episode-2', waiting_since: '2026-09-25T10:45:00Z' })],
      now,
      30,
      [],
    ).map((row) => row.id),
  ).toEqual([7])
  expect(dueOperatorWaitingEmails([item()], now, 30, [item()])).toEqual([])
  expect(dueOperatorWaitingEmails([item()], now, 0, [])).toEqual([])
})

test('local loop skips without a hosted sign-in and does not read or record waiting text', async () => {
  const calls: string[] = []
  await deliverOperatorWaitingEmails({
    delay: () => 30,
    signedIn: async () => null,
    readWaiting: async () => {
      calls.push('waiting')
      return [item()]
    },
    push: async () => {
      calls.push('push')
      return { id: 'mail', status: 'sent', reason: null }
    },
    record: () => calls.push('record'),
  })
  expect(calls).toEqual([])
})

test('local loop records only successful pushes and logs failures for retry', async () => {
  const recorded: number[] = []
  const errors: string[] = []
  await deliverOperatorWaitingEmails({
    delay: () => 30,
    signedIn: async () => 'user',
    readWaiting: async () => [item(), item({ id: 8, episode: 'episode-2' })],
    ledger: () => [],
    now: () => new Date('2026-09-25T11:00:00.000Z'),
    taskRecordId: () => null,
    push: async (body) => {
      if ((body as { item_id: number }).item_id === 8) throw new Error('offline')
      return { id: 'mail', status: 'sent', reason: null }
    },
    record: (row) => recorded.push(row.id),
    error: (message) => errors.push(message),
  })
  expect(recorded).toEqual([7])
  expect(errors).toEqual(['hub: operator waiting email push failed: Error: offline'])
})

test('local loop sends a task UUID only when the waiting key resolves', async () => {
  const bodies: Array<{ task_key: string | null; task_id: string | null }> = []
  const taskId = '01990000-0000-7000-8000-000000000943'
  await deliverOperatorWaitingEmails({
    delay: () => 30,
    signedIn: async () => 'user',
    readWaiting: async () => [item(), item({ id: 8, task_key: 'MISSING-8', episode: 'episode-2' })],
    ledger: () => [],
    now: () => new Date('2026-09-25T11:00:00.000Z'),
    taskRecordId: (key) => (key === 'DEV-943' ? taskId : null),
    push: async (body) => {
      const pushed = body as { task_key: string | null; task_id: string | null }
      bodies.push({ task_key: pushed.task_key, task_id: pushed.task_id })
      return { id: 'mail', status: 'sent', reason: null }
    },
    record: () => undefined,
  })
  expect(bodies).toEqual([
    { task_key: 'DEV-943', task_id: taskId },
    { task_key: 'MISSING-8', task_id: null },
  ])
})

test('local loop names each waiting item by its kind-specific UUID', async () => {
  const bodies: Array<{ kind: string; item_record_id: string | null }> = []
  const workflowRecordId = '01990000-0000-7000-8000-000000000008'
  await deliverOperatorWaitingEmails({
    delay: () => 30,
    signedIn: async () => 'user',
    readWaiting: async () => [
      item(),
      item({
        kind: 'workflow',
        id: 8,
        workflow_cursor_record_id: workflowRecordId,
        episode: 'episode-2',
      }),
    ],
    ledger: () => [],
    now: () => new Date('2026-09-25T11:00:00.000Z'),
    taskRecordId: () => null,
    push: async (body) => {
      const pushed = body as { kind: string; item_record_id: string | null }
      bodies.push({ kind: pushed.kind, item_record_id: pushed.item_record_id })
      return { id: 'mail', status: 'sent', reason: null }
    },
    record: () => undefined,
  })
  expect(bodies).toEqual([
    { kind: 'question', item_record_id: item().question_record_id },
    { kind: 'workflow', item_record_id: workflowRecordId },
  ])
})

test('local loop records abandonment once but leaves intent and failed results retryable', async () => {
  const recorded: number[] = []
  const errors: string[] = []
  const statuses = ['intent', 'failed', 'abandoned'] as const
  await deliverOperatorWaitingEmails({
    delay: () => 30,
    signedIn: async () => 'user',
    readWaiting: async () => statuses.map((_, id) => item({ id: id + 1, episode: `e-${id}` })),
    ledger: () => [],
    now: () => new Date('2026-09-25T11:00:00.000Z'),
    taskRecordId: () => null,
    push: async (body) => {
      const status = statuses[(body as { item_id: number }).item_id - 1]!
      return { id: 'mail', status, reason: status === 'intent' ? null : 'delivery refused' }
    },
    record: (row) => recorded.push(row.id),
    error: (message) => errors.push(message),
  })
  expect(recorded).toEqual([3])
  expect(errors).toEqual([
    'hub: operator waiting email push failed: Error: delivery refused',
    'hub: operator waiting email abandoned after retries: delivery refused',
  ])
})
