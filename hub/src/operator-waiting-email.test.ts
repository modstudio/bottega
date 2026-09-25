import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../shared/brand.ts'
import type { OperatorWaitingItem } from '../../shared/orch-contract.ts'
import { deliverOperatorWaitingEmails, dueOperatorWaitingEmails } from './operator-waiting-email.ts'

const item = (patch: Partial<OperatorWaitingItem> = {}): OperatorWaitingItem => ({
  kind: 'question',
  id: 7,
  run_id: 42,
  project: PLATFORM_NAME.toLowerCase(),
  task_key: 'DEV-943',
  session_id: null,
  question: 'Which approach?',
  options: ['A', 'B'],
  recommendation: 'A',
  why: 'It is safer.',
  waiting_since: '2026-09-25T10:00:00.000Z',
  episode: 'episode-1',
  answer_command: 'orch answer 42 --q7 --from-operator "<ruling>"',
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
