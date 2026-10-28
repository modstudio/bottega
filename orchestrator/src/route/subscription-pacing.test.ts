import { expect, test } from 'bun:test'
import {
  decideSubscriptionPacing,
  PACE_HEADROOM_PERCENT,
  type SubscriptionPacingInput,
} from './subscription-pacing.ts'

const WINDOW_MINUTES = 10_080
const RESET_SECONDS = 2_000_000_000
const nowAt = (elapsedPercent: number) =>
  (RESET_SECONDS - WINDOW_MINUTES * 60 + WINDOW_MINUTES * 60 * (elapsedPercent / 100)) * 1000

const input = (overrides: Partial<SubscriptionPacingInput> = {}): SubscriptionPacingInput => ({
  now: nowAt(10),
  reading: { usedPercentEnd: 21, windowMinutes: WINDOW_MINUTES, resetsAt: RESET_SECONDS },
  tokensSinceReading: 0,
  calibration: null,
  writesRepo: false,
  highStakesLens: false,
  ...overrides,
})

test("today's reading holds high-stakes and ordinary paced jobs", () => {
  expect(decideSubscriptionPacing(input({ highStakesLens: true }))?.estimatePercent).toBe(21)
  expect(decideSubscriptionPacing(input())?.refusal).toContain('ahead of')
})

test('on pace allows a high-stakes lens while standard work needs headroom', () => {
  const reading = { usedPercentEnd: 10, windowMinutes: WINDOW_MINUTES, resetsAt: RESET_SECONDS }
  expect(decideSubscriptionPacing(input({ reading, highStakesLens: true }))).toBeNull()
  expect(decideSubscriptionPacing(input({ reading }))?.headroomPercent).toBe(PACE_HEADROOM_PERCENT)
})

test('a writing job is never paced', () => {
  expect(decideSubscriptionPacing(input({ writesRepo: true }))).toBeNull()
})

test('a past-window reading counts as no reading', () => {
  expect(
    decideSubscriptionPacing(
      input({
        now: RESET_SECONDS * 1000,
        reading: { usedPercentEnd: 1, windowMinutes: WINDOW_MINUTES, resetsAt: RESET_SECONDS - 1 },
      }),
    )?.refusal,
  ).toContain('no reading in the current window')
})

test('calibration estimates current-window use without a reading', () => {
  const hold = decideSubscriptionPacing(
    input({
      reading: null,
      tokensSinceReading: 12_000,
      calibration: {
        tokensPerPercent: 1_000,
        windowMinutes: WINDOW_MINUTES,
        resetsAt: RESET_SECONDS,
      },
      highStakesLens: true,
    }),
  )
  expect(hold).toMatchObject({ estimatePercent: 12, pacePercent: 10 })
})

test('no current reading and no calibration holds every paced job', () => {
  expect(decideSubscriptionPacing(input({ reading: null }))?.estimatePercent).toBeNull()
})
