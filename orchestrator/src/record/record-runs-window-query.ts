/** Owns the hosted run window's query contract. Must not know how the window is read. */
import { z } from 'zod'

const hours = z.coerce
  .number()
  .pipe(z.union([z.literal(24), z.literal(48), z.literal(168), z.literal(720)]))
const limit = z.coerce.number().pipe(z.union([z.literal(25), z.literal(50), z.literal(100)]))

export const runsWindowQuery = z.object({
  hours,
  agent: z.string().max(64).default(''),
  project: z.string().max(64).default(''),
  search: z.string().max(200).default(''),
  offset: z.coerce.number().int().min(0).default(0),
  limit: limit.default(50),
})
