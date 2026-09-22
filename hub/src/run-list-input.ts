import { z } from 'zod'
import { RUN_PAGE_LIMITS } from './run-display.ts'

export const runHours = z.union([z.literal(24), z.literal(48), z.literal(168), z.literal(720)])

export const runListInput = z.object({
  hours: runHours,
  agent: z.string().max(64).default(''),
  project: z.string().max(64).default(''),
  offset: z.number().int().min(0).default(0),
  limit: z.union(RUN_PAGE_LIMITS.map((size) => z.literal(size))).default(50),
  search: z.string().max(200).default(''),
})
