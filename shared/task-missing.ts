import { PLATFORM_SLUG } from './brand.ts'
import { refusal, renderRefusal } from './refusal.ts'

export function missingTaskLine(key: string): string {
  return `no task ${key}`
}

export function missingTaskMessage(key: string): string {
  return renderRefusal(
    refusal(missingTaskLine(key), {
      kind: 'edit',
      text: `if it was just created or promoted, run ${PLATFORM_SLUG} record pull and retry`,
    }),
  )
}

export function namesMissingTask(text: string, key: string): boolean {
  const expected = missingTaskLine(key)
  return text.split('\n').some((line) => line.trim() === expected)
}

/** Match either task-read port's missing-record line without depending on record-id casing. */
export function namesMissingTaskRecord(text: string, recordId: string): boolean {
  const expected = missingTaskLine(recordId).toLowerCase()
  const localExpected = `no task record ${recordId}`.toLowerCase()
  return text
    .split('\n')
    .some((line) => [expected, localExpected].includes(line.trim().toLowerCase()))
}
