export const REHEARSAL_NOTICE_LIMIT = 20

function migrateFailureText(migrateOutput: string): string {
  return migrateOutput
    .split('\n')
    .filter((line) => !line.startsWith('MIGRATE NOTICE '))
    .join('\n')
    .replace(/^(?:[\t ]*\n)+|(?:\n[\t ]*)+$/g, '')
}

function renderRehearsalNoticeLines(migrateOutput: string): string[] {
  const notices = migrateOutput.split('\n').filter((line) => line.startsWith('MIGRATE NOTICE '))
  const forwarded = notices
    .slice(0, REHEARSAL_NOTICE_LIMIT)
    .map((line) => `REHEARSAL NOTICE ${line}`)
  const dropped = notices.length - forwarded.length
  if (dropped > 0) forwarded.push(`REHEARSAL NOTICE-TRUNCATED ${dropped}`)
  return forwarded
}

export function rehearsalNoticeOutput(migrateOutput: string): string {
  const lines = renderRehearsalNoticeLines(migrateOutput)
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

export function rehearsalMigrateFailureOutput(migrateOutput: string): string {
  return `${[
    ...renderRehearsalNoticeLines(migrateOutput),
    `REHEARSAL FAIL ${migrateFailureText(migrateOutput)}`,
  ].join('\n')}\n`
}
