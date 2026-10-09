import { z } from 'zod'
import { SubjectOutputSchema } from '../../shared/subjects.ts'

export const SubjectListSchema = z.array(SubjectOutputSchema)
export type SubjectList = z.infer<typeof SubjectListSchema>
