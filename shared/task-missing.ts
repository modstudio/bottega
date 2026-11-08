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
