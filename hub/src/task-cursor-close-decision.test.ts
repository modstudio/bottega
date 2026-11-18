import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../shared/brand.ts'
import { decideTaskCursorClose, type OpenTaskWorkflowCursor } from './task-cursor-close-decision.ts'

const cursor = (values: Partial<OpenTaskWorkflowCursor> = {}): OpenTaskWorkflowCursor => ({
  id: 41,
  record_id: '01a1ed7c-1111-7111-8111-111111111111',
  project: PLATFORM_NAME,
  workflow_slug: 'ship-task',
  workflow_key: 'DEV-2436',
  session_id: 'foreign-session',
  live_runs: [],
  ...values,
})

describe('task cursor close decision', () => {
  test('matches the task key case-insensitively and excludes other keys', () => {
    const matching = cursor({ workflow_key: 'dev-2436' })
    expect(
      decideTaskCursorClose({
        key: 'DEV-2436',
        cursors: [cursor({ id: 42, workflow_key: 'DEV-9999' }), matching],
        callingSession: null,
      }),
    ).toEqual({ action: 'abandon', cursors: [matching] })
  })

  test("excludes the calling session's cursor only when a calling session is known", () => {
    const own = cursor({ session_id: 'calling-session' })
    expect(
      decideTaskCursorClose({
        key: 'DEV-2436',
        cursors: [own],
        callingSession: 'calling-session',
      }),
    ).toEqual({ action: 'abandon', cursors: [] })
    expect(
      decideTaskCursorClose({ key: 'DEV-2436', cursors: [own], callingSession: null }),
    ).toEqual({ action: 'abandon', cursors: [own] })
  })

  test('refuses when a selected cursor has live work and lists every selected live run', () => {
    expect(
      decideTaskCursorClose({
        key: 'DEV-2436',
        callingSession: null,
        cursors: [
          cursor({
            live_runs: [
              { number: 37503, record_id: '01a1ed7c-2222-7222-8222-222222222222' },
              { number: 37504, record_id: '01a1ed7c-3333-7333-8333-333333333333' },
            ],
          }),
        ],
      }),
    ).toEqual({
      action: 'refuse',
      reason:
        'refusing to close task DEV-2436 while its cursor has live work:\n' +
        `cursor 41 has live run 37503 [01a1ed7c-2222-7222-8222-222222222222]; clear it with: ${PLATFORM_SLUG} run stop 37503\n` +
        `cursor 41 has live run 37504 [01a1ed7c-3333-7333-8333-333333333333]; clear it with: ${PLATFORM_SLUG} run stop 37504`,
    })
  })

  test('ignores live work on another task and on the calling session cursor', () => {
    const liveRuns = [{ number: 37503, record_id: '01a1ed7c-2222-7222-8222-222222222222' }]
    expect(
      decideTaskCursorClose({
        key: 'DEV-2436',
        callingSession: 'calling-session',
        cursors: [
          cursor({ id: 42, workflow_key: 'DEV-9999', live_runs: liveRuns }),
          cursor({ id: 43, session_id: 'calling-session', live_runs: liveRuns }),
        ],
      }),
    ).toEqual({ action: 'abandon', cursors: [] })
  })
})
