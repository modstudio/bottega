// concern: question-ruling-remedy
/** Names the command that records a ruling for either kind of question owner. */

const shellWord = (value: string) =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`

export function questionRulingRemedy(row: {
  id: number
  root_id: number | null
  workflow_slug: string | null
  mode_slug: string | null
  repo: string | null
  args: string | null
}): string {
  if (row.root_id !== null) return `orch answer ${row.root_id} --q${row.id} "<ruling>"`
  const args = JSON.parse(row.args ?? '{}') as Record<string, string>
  const flags = Object.entries(args)
    .map(([key, value]) => ` --arg ${shellWord(`${key}=${value}`)}`)
    .join('')
  return (
    `orch workflow rule ${shellWord(row.workflow_slug!)} ` +
    `--project ${shellWord(row.repo!)} --mode ${shellWord(row.mode_slug!)}${flags} --ruling "<ruling>"`
  )
}
