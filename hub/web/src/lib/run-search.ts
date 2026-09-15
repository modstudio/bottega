import { compactTokens, duration } from './format'
import { PROJECT_FALLBACK } from './project'

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

export function runSearchText(row: SearchableRun | SearchableLiveRun) {
  if ('task' in row) {
    return [
      row.project ?? PROJECT_FALLBACK,
      row.task ?? '-',
      row.agent,
      `${row.job || '-'}${row.lens ? ` ${row.lens}` : ''}${row.probe ? ' probe' : ''}`,
      row.engaged,
      runVerdictText(row),
      row.evidence_excluded ? `Not routing evidence: ${row.evidence_excluded}` : '',
      compactTokens(row.tokens),
      row.costUsd == null ? '-' : `$${row.costUsd.toFixed(2)}`,
      runEasternTime(row.at, true),
    ].join(' ')
  }
  return [
    row.agent,
    row.job,
    row.repo ?? PROJECT_FALLBACK,
    duration(row.elapsedMs),
    row.prompt_head.slice(0, 90),
  ].join(' ')
}

export function matchesRunSearch(row: SearchableRun | SearchableLiveRun, query: string) {
  return runSearchText(row).toLowerCase().includes(query.trim().toLowerCase())
}
