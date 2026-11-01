export const REHEARSAL_NOTICE_LIMIT = 20

export function migrateFailureText(migrateOutput: string): string {
  return migrateOutput
    .split('\n')
    .filter((line) => !line.startsWith('MIGRATE NOTICE '))
    .join('\n')
    .replace(/^(?:[\t ]*\n)+|(?:\n[\t ]*)+$/g, '')
}

export function renderRehearsalNoticeLines(migrateOutput: string): string[] {
  const notices = migrateOutput.split('\n').filter((line) => line.startsWith('MIGRATE NOTICE '))
  const forwarded = notices
    .slice(0, REHEARSAL_NOTICE_LIMIT)
    .map((line) => `REHEARSAL NOTICE ${line}`)
  const dropped = notices.length - forwarded.length
  if (dropped > 0) forwarded.push(`REHEARSAL NOTICE-TRUNCATED ${dropped}`)
  return forwarded
}
