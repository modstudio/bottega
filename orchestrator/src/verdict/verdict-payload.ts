// concern: verdict-payload
/** The transport-neutral contract for carrying one scored run to the hosted record. */
import { z } from 'zod'
import type {
  ReviewCoverage,
  ReviewLimits,
  ReviewOverlap,
  ReviewReproduced,
} from '../review/review-vocabulary.ts'
import {
  REVIEW_COVERAGE,
  REVIEW_LIMITS,
  REVIEW_OVERLAP,
  REVIEW_REPRODUCED,
} from '../review/review-vocabulary.ts'
import {
  DELIVERY,
  type Delivery,
  FIDELITY,
  type Fidelity,
  QUALITY,
  type Quality,
} from '../score/score.ts'

type VerdictGrades = {
  reproduced: ReviewReproduced | null
  coverage: ReviewCoverage | null
  limits: ReviewLimits | null
  overlap: ReviewOverlap | null
}

export type VerdictInput = VerdictGrades & {
  delivery: Delivery
  quality: Quality | null
  fidelity: Fidelity | null
  note: string | null
  scoredAt: string
  scoredBy: string
}

export type VerdictPayload = VerdictInput & {
  id: string
  spaceId: string
  projectName: string | null
  machineId: string
  localId: number
  withheldFields?: string[] | null
  updatedAt: string
}

export const VERDICT_INPUT_SCHEMA = z.object({
  delivery: z.enum(DELIVERY),
  quality: z.enum(QUALITY).nullable(),
  fidelity: z.enum(FIDELITY).nullable(),
  note: z.string().nullable(),
  scoredAt: z.string().datetime({ offset: true }),
  scoredBy: z.string().min(1),
  reproduced: z.enum(REVIEW_REPRODUCED).nullable().default(null),
  coverage: z.enum(REVIEW_COVERAGE).nullable().default(null),
  limits: z.enum(REVIEW_LIMITS).nullable().default(null),
  overlap: z.enum(REVIEW_OVERLAP).nullable().default(null),
}) satisfies z.ZodType<VerdictInput>

export const VERDICT_PAYLOAD_SCHEMA = VERDICT_INPUT_SCHEMA.extend({
  id: z.string(),
  spaceId: z.string(),
  projectName: z.string().nullable(),
  machineId: z.string(),
  localId: z.number().int(),
  withheldFields: z.array(z.string()).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
}) satisfies z.ZodType<VerdictPayload>

export const VERDICT_PAYLOAD_COLUMNS = [
  'id',
  'spaceId',
  'projectName',
  'machineId',
  'localId',
  'delivery',
  'quality',
  'fidelity',
  'note',
  'scoredAt',
  'scoredBy',
  'reproduced',
  'coverage',
  'limits',
  'overlap',
  'withheldFields',
  'updatedAt',
] as const satisfies readonly (keyof VerdictPayload)[]
