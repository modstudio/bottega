// concern: route subscription pacing
/** Pure pacing policy for quota-bound subscription agents. */

export const PACE_HEADROOM_PERCENT = 5

export type QuotaPacingReading = {
  usedPercentEnd: number
  windowMinutes: number
  resetsAt: number
}

export type QuotaPacingCalibration = {
  tokensPerPercent: number
  windowMinutes: number
  resetsAt: number
}

export type SubscriptionPacingHold = {
  estimatePercent: number | null
  pacePercent: number | null
  headroomPercent: number
  resetsAt: number | null
  refusal: string
}

export type SubscriptionPacingInput = {
  now: number
  reading: QuotaPacingReading | null
  tokensSinceReading: number
  calibration: QuotaPacingCalibration | null
  writesRepo: boolean
  highStakesLens: boolean
}

function currentReading(
  reading: QuotaPacingReading | null,
  nowSeconds: number,
): QuotaPacingReading | null {
  if (!reading || reading.windowMinutes <= 0) return null
  const startsAt = reading.resetsAt - reading.windowMinutes * 60
  return nowSeconds >= startsAt && nowSeconds < reading.resetsAt ? reading : null
}

function pacePercent(nowSeconds: number, resetsAt: number, windowMinutes: number): number {
  const startsAt = resetsAt - windowMinutes * 60
  return Math.max(0, Math.min(100, ((nowSeconds - startsAt) / (windowMinutes * 60)) * 100))
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`
}

/** Writing work is unpaced; every other job must fit its applicable quota headroom. */
export function decideSubscriptionPacing(
  input: SubscriptionPacingInput,
): SubscriptionPacingHold | null {
  if (input.writesRepo) return null
  const nowSeconds = input.now / 1000
  const reading = currentReading(input.reading, nowSeconds)
  const calibration =
    input.calibration && input.calibration.tokensPerPercent > 0 ? input.calibration : null
  const headroomPercent = input.highStakesLens ? 0 : PACE_HEADROOM_PERCENT
  if (!reading && !calibration) {
    return {
      estimatePercent: null,
      pacePercent: null,
      headroomPercent,
      resetsAt: null,
      refusal:
        'subscription quota pace unavailable: no reading in the current window and no calibration',
    }
  }

  const window = reading ?? calibration!
  const pace = pacePercent(nowSeconds, window.resetsAt, window.windowMinutes)
  const estimate = reading
    ? reading.usedPercentEnd +
      (calibration ? input.tokensSinceReading / calibration.tokensPerPercent : 0)
    : input.tokensSinceReading / calibration!.tokensPerPercent
  const allowance = pace - headroomPercent
  if (estimate <= allowance) return null
  const ahead = estimate - allowance
  const reset = new Date(window.resetsAt * 1000).toISOString()
  return {
    estimatePercent: estimate,
    pacePercent: pace,
    headroomPercent,
    resetsAt: window.resetsAt,
    refusal:
      `subscription quota estimate ${percent(estimate)} is ${percent(ahead)} ahead of ` +
      `the ${percent(pace)} window pace with ${percent(headroomPercent)} headroom; resets ${reset}`,
  }
}
