// concern: review-funnel-policy
/** Reads and validates the one global review-funnel policy document. */

import { z } from 'zod'
import { getDoc } from '../doc/docs.ts'
import { REVIEW_WINDOW } from '../review/review-evidence-sql.ts'
import { MIN_REVIEW_TRIAGED } from '../review/review-triage.ts'

const modeSchema = z.enum(['evaluate', 'enforce'])

export const reviewFunnelPolicySchema = z.strictObject({
  sizeThresholds: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
  fileCountBump: z.number().int().nonnegative(),
  unlistedRisk: z.literal(2),
  ceiling: z.literal('tier'),
  laterRound: z.strictObject({
    minTier: z.literal(3),
    triggers: z.tuple([z.literal('accepted-finding'), z.literal('newly-touched-path')]),
  }),
  selection: z.strictObject({
    window: z.number().int().positive(),
    minTriaged: z.number().int().positive(),
    explorationShare: z.number().min(0).max(1),
    pinned: z.array(z.string().trim().min(1)),
  }),
  modes: z.strictObject({
    tier: modeSchema,
    budget: modeSchema,
    laterRound: modeSchema,
    selection: modeSchema,
  }),
})

export type ReviewFunnelPolicy = z.infer<typeof reviewFunnelPolicySchema>

export const DEFAULT_REVIEW_FUNNEL_POLICY: ReviewFunnelPolicy = {
  sizeThresholds: [10, 50, 400],
  fileCountBump: 8,
  unlistedRisk: 2,
  ceiling: 'tier',
  laterRound: {
    minTier: 3,
    triggers: ['accepted-finding', 'newly-touched-path'],
  },
  selection: {
    window: REVIEW_WINDOW,
    minTriaged: MIN_REVIEW_TRIAGED,
    explorationShare: 0.1,
    pinned: ['correctness'],
  },
  modes: {
    tier: 'evaluate',
    budget: 'evaluate',
    laterRound: 'evaluate',
    selection: 'evaluate',
  },
}

export const SEEDED_REVIEW_FUNNEL_POLICY_BODY = `${JSON.stringify(DEFAULT_REVIEW_FUNNEL_POLICY, null, 2)}\n`

export type VersionedReviewFunnelPolicy = {
  policy: ReviewFunnelPolicy
  policyVersion: string
}

/** The policy document is optional so empty and freshly-created stores retain today's behavior. */
export function activeReviewFunnelPolicy(): VersionedReviewFunnelPolicy {
  const doc = getDoc('global', null, 'review-funnel-policy')
  if (!doc) return { policy: DEFAULT_REVIEW_FUNNEL_POLICY, policyVersion: 'builtin' }
  let body: unknown
  try {
    body = JSON.parse(doc.body)
  } catch (cause) {
    throw new Error(`global document review-funnel-policy is not valid JSON: ${String(cause)}`)
  }
  const parsed = reviewFunnelPolicySchema.safeParse(body)
  if (!parsed.success) {
    throw new Error(`global document review-funnel-policy is invalid: ${parsed.error.message}`)
  }
  return { policy: parsed.data, policyVersion: doc.revision ?? 'builtin' }
}
