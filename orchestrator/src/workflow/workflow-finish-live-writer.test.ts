import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { decideFinishWithLiveWriter } from './workflow-finish-live-writer.ts'

const input = {
  finishes: true,
  taskKey: 'DEV-2414',
  cursor: 2414,
  cursorReference: ' --cursor 2414 --project fixture',
  cursorSession: 'owning-session',
  callerSession: 'owning-session',
  runs: [{ number: 91, job: 'implement', writes: true, session: 'owning-session' }],
}

test('refuses a finishing close with a live writer and names handoff', () => {
  expect(decideFinishWithLiveWriter(input)).toContain(
    `${PLATFORM_SLUG} workflow handoff <next> --cursor 2414 --project fixture --reason "<why>"`,
  )
})

test('allows non-writing, non-finishing, and other-session runs', () => {
  expect(
    decideFinishWithLiveWriter({
      ...input,
      runs: [{ ...input.runs[0]!, writes: false }],
    }),
  ).toBeNull()
  expect(decideFinishWithLiveWriter({ ...input, finishes: false })).toBeNull()
  expect(
    decideFinishWithLiveWriter({
      ...input,
      runs: [{ ...input.runs[0]!, session: 'another-session' }],
    }),
  ).toBeNull()
})

test('the cursor session takes precedence over a differing caller session', () => {
  const owningRefusal = decideFinishWithLiveWriter(input)
  expect(owningRefusal).not.toBeNull()
  expect(decideFinishWithLiveWriter({ ...input, callerSession: 'foreign-session' })).toBe(
    owningRefusal,
  )
})
