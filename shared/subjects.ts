import { z } from 'zod'

export const SubjectDefinitionSchema = z
  .string()
  .trim()
  .min(1, 'a subject definition must be one non-empty line')
  .refine((value) => !value.includes('\n') && !value.includes('\r'), {
    message: 'a subject definition must be one non-empty line',
  })

export const SubjectOutputSchema = z.object({
  id: z.string().uuid(),
  project: z.string(),
  name: z.string(),
  definition: z.string(),
  position: z.number().int().nonnegative(),
  parentId: z.string().uuid().nullable(),
  state: z.enum(['active', 'retired']),
  retiredAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type SubjectOutput = z.infer<typeof SubjectOutputSchema>
