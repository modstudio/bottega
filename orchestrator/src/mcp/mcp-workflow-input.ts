// concern: mcp
/** Owns the public input shape for closing one workflow step over MCP. */

import { z } from 'zod'

export const nextWorkflowStepInputSchema = z.object({
  slug: z.string().trim().min(1),
  project: z.string().trim().min(1),
  mode: z.string().trim().min(1).optional(),
  args: z.record(z.string(), z.string()).optional(),
  note: z.string().trim().min(1),
  outcome: z.string().trim().min(1).optional(),
  ruling: z.number().int().positive().optional(),
  self_ruling: z.string().trim().min(1).optional(),
  self_ruling_basis: z.string().optional(),
  question: z.string().trim().min(1).optional(),
  review: z.union([z.number().int().positive(), z.uuid()]).optional(),
  gate: z.number().int().positive().optional(),
  run: z.union([z.number().int().positive(), z.string().trim().min(1)]).optional(),
  artifact: z.string().trim().min(1).optional(),
  task: z.string().trim().min(1).optional(),
  cursor: z.number().int().positive().optional(),
  defer: z.string().trim().min(1).optional(),
  satisfies: z.number().int().positive().optional(),
})
