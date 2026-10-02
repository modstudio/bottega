// concern: tracked recipe execution-context grammar
/** Defines where a recipe command runs. Must not know commands or lifecycle order. */
import { z } from 'zod'

const strictObject = <Shape extends z.core.$ZodLooseShape>(shape: Shape) =>
  z.strictObject(shape, { error: 'unknown-key rule: objects may not contain unknown keys' })

export const execContextSchema = z.discriminatedUnion('where', [
  strictObject({ where: z.literal('host') }),
  strictObject({ where: z.literal('container'), service: z.string().min(1) }),
  strictObject({ where: z.literal('as-user'), user: z.string().min(1) }),
])
