import { z } from 'zod'
import { PLATFORM_SLUG } from './brand.ts'

export const CHECK_EXECUTION_FILE_ENV = `${PLATFORM_SLUG.toUpperCase()}_CHECK_EXECUTION_FILE`
export const UNIT_TEST_CHECK_CATEGORY = 'unit-tests'

const CheckExecutionRecordSchema = z
  .object({
    check: z.string().min(1),
    category: z.string().min(1).optional(),
    wallMs: z.number().finite().nonnegative(),
    cpuMs: z.number().finite().nonnegative().optional(),
    exitCode: z.number().int(),
    remaining: z.number().int().nonnegative().optional(),
  })
  .strict()

export type CheckExecutionRecord = z.infer<typeof CheckExecutionRecordSchema>

export function parseCheckExecutionLines(text: string): {
  records: CheckExecutionRecord[]
  rejected: number
} {
  const records: CheckExecutionRecord[] = []
  let rejected = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      rejected += 1
      continue
    }
    const parsed = CheckExecutionRecordSchema.safeParse(value)
    if (parsed.success) records.push(parsed.data)
    else rejected += 1
  }
  return { records, rejected }
}
