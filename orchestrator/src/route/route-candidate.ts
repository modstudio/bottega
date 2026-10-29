// concern: route
/** The scored and operational facts exposed for one routing candidate. */
import type { BillingKeyHold } from './billing-key-hold.ts'
import type { CostPerAcceptedResult } from './route-cost.ts'
import type { RunUsageMedians } from './route-statistics.ts'
import type { SubscriptionPacingHold } from './subscription-pacing.ts'

export type Candidate = {
  agent: string
  runs: number
  scored: number
  /** Failed or abandoned runs without an explicit judgment. */
  failures: number
  /** Explicit judgments whose delivery was none, used by the exploration filter. */
  none: number
  /** Explicit verdicts plus unjudged failures; the MIN_SAMPLE denominator. */
  evidence: number
  evidenceModel: string | null
  /** Mean verdict weight, or null until anything has been judged. */
  score: number | null
  /** Score pulled toward the job-wide proven-agent mean by MIN_SAMPLE judgments. */
  shrunk: number | null
  latencyMs: number | null
  tokens: number
  usage: RunUsageMedians
  costUsd: number
  free: boolean
  eligible: boolean
  why: string
  /** Most recent uncleared quota or stale-auth failure. */
  cooling: string | null
  /** Shared provider account currently held by a billing failure. */
  billingHold: BillingKeyHold | null
  /** Canonical operator remedy for the shared provider account hold. */
  billingHoldRefusal: string | null
  /** Quota-bound subscription currently ahead of its window pace. */
  subscriptionPacingHold: SubscriptionPacingHold | null
  declared: string[] | null
  preferred: boolean
  maxConcurrent: number | null
  runningRunIds: string[]
  routedReason?: string
  costPerAccepted?: CostPerAcceptedResult
}
