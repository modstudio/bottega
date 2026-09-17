export type SearchableRun = {
  id: number
  agent: string
  job: string | null
  task: string | null
  project: string | null
  at: string
  engaged: string
  running: boolean
  status: string
  delivery: string | null
  quality: string | null
  tokens: number | null
  costUsd: number | null
  probe: boolean
  lens: string | null
  evidence_excluded?: string | null
}

export type SearchableLiveRun = {
  id: number
  agent: string
  job: string
  repo: string | null
  elapsedMs: number
  prompt_head: string
}

export function runEasternTime(value: string, includeDay = false) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    ...(includeDay ? { month: 'short', day: 'numeric' } : {}),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? ''
  const time = `${part('hour')}:${part('minute')} ${part('dayPeriod').toLowerCase()}`
  return includeDay ? `${part('month')} ${part('day')} ${time}` : time
}

export function runVerdictText(row: SearchableRun) {
  if (row.running) return 'running'
  if (row.delivery) return `${row.delivery}${row.quality ? ` / ${row.quality}` : ''}`
  if (row.status !== 'ok') return row.status
  if (row.probe) return 'probe'
  if (row.evidence_excluded) return ''
  return 'Unscored'
}
