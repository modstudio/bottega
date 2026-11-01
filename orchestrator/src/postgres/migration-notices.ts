export const REHEARSAL_NOTICE_LIMIT = 20

export function renderRehearsalNoticeLines(migrateOutput: string): string[] {
  const notices = migrateOutput
    .split('\n')
    .filter((line) => line.startsWith('MIGRATE NOTICE '))
  const forwarded = notices
    .slice(0, REHEARSAL_NOTICE_LIMIT)
    .map((line) => `REHEARSAL NOTICE ${line}`)
  const dropped = notices.length - forwarded.length
  if (dropped > 0) forwarded.push(`REHEARSAL NOTICE-TRUNCATED ${dropped}`)
  return forwarded
}
