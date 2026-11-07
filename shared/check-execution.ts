import { z } from 'zod'
import { PLATFORM_SLUG } from './brand.ts'

export const CHECK_EXECUTION_FILE_ENV = `${PLATFORM_SLUG.toUpperCase()}_CHECK_EXECUTION_FILE`
export const UNIT_TEST_CHECK_CATEGORY = 'unit-tests'
export const UNCHECKED_EXIT_CODE = 77

export function exitUnchecked(reason: string): never {
  console.log(`unchecked: ${reason}`)
  process.exit(UNCHECKED_EXIT_CODE)
}

const CheckExecutionRecordSchema = z
  .object({
    check: z.string().min(1),
    category: z.string().min(1).optional(),
    wallMs: z.number().finite().nonnegative(),
    cpuMs: z.number().finite().nonnegative().optional(),
    exitCode: z.number().int(),
    unchecked: z.string().min(1).optional(),
    remaining: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((record) => record.unchecked === undefined || record.exitCode === UNCHECKED_EXIT_CODE, {
    message: `unchecked records must use exit code ${UNCHECKED_EXIT_CODE}`,
  })

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
