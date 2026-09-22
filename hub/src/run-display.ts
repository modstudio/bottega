const compactNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

export const PROJECT_FALLBACK = 'elsewhere'
const DEFAULT_RUN_LIMIT = 50
export const RUN_PAGE_LIMITS = [25, 50, 100] as const
export type RunPageLimit = (typeof RUN_PAGE_LIMITS)[number]

export type SearchableRun = {
  id: number | string
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
  id: number | string
  agent: string
  job: string
  repo: string | null
  elapsedMs: number
  prompt_head: string
}

export type RunDisplay = {
  project: string
  took: string
  verdict: string
  exclusion: string
  tokens: string
  cost: string
  started: string
}

export type LiveDisplay = {
  project: string
  elapsed: string
  prompt: string
}

function compactTokens(value: number | null | undefined) {
  if (value == null) return '-'
  if (value >= 1e9) return `${compactNumber.format(value / 1e9)}B`
  if (value >= 1e6) return `${compactNumber.format(value / 1e6)}M`
  if (value >= 1e3) return `${compactNumber.format(value / 1e3)}K`
  return String(Math.round(value))
}

export function duration(ms: number) {
  const seconds = Math.round(ms / 1000)
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${seconds}s`
}

function runEasternTime(value: string, includeDay = false) {
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

function runVerdictText(row: SearchableRun) {
  if (row.running) return 'running'
  if (row.delivery) return `${row.delivery}${row.quality ? ` / ${row.quality}` : ''}`
  if (row.status !== 'ok') return row.status
  if (row.probe) return 'probe'
  if (row.evidence_excluded) return ''
  return 'Unscored'
}

export function runRowDisplay(row: SearchableRun, now: number): RunDisplay {
  return {
    project: row.project ?? PROJECT_FALLBACK,
    took: row.running ? duration(now - new Date(row.at).getTime()) : row.engaged,
    verdict: runVerdictText(row),
    exclusion: row.evidence_excluded ? `Not routing evidence: ${row.evidence_excluded}` : '',
    tokens: compactTokens(row.tokens),
    cost: row.costUsd == null ? '-' : `$${row.costUsd.toFixed(2)}`,
    started: runEasternTime(row.at, true),
  }
}

export function liveRowDisplay(row: SearchableLiveRun): LiveDisplay {
  return {
    project: row.repo ?? PROJECT_FALLBACK,
    elapsed: duration(row.elapsedMs),
    prompt: row.prompt_head.slice(0, 90),
  }
}

export function runSearchText(row: SearchableRun | SearchableLiveRun, now = 0) {
  if ('task' in row) {
    const display = runRowDisplay(row, now)
    return [
      display.project,
      row.task ?? '-',
      row.agent,
      `${row.job || '-'}${row.lens ? ` ${row.lens}` : ''}${row.probe ? ' probe' : ''}`,
      row.running ? '' : display.took,
      display.verdict,
      display.exclusion,
      display.tokens,
      display.cost,
      display.started,
    ].join(' ')
  }
  const display = liveRowDisplay(row)
  return [row.agent, row.job, display.project, display.elapsed, display.prompt].join(' ')
}

export function matchesRunSearch(row: SearchableRun | SearchableLiveRun, query: string, now = 0) {
  return runSearchText(row, now).toLowerCase().includes(query.trim().toLowerCase())
}

export function runPageLimit(limit: number | undefined): RunPageLimit {
  return RUN_PAGE_LIMITS.find((allowed) => allowed === limit) ?? DEFAULT_RUN_LIMIT
}

export function appliedRunOffset(offset: number, matched: number, limit: number): number {
  if (matched <= 0) return 0
  const lastPage = Math.floor((matched - 1) / limit) * limit
  return Math.min(Math.max(0, offset), lastPage)
}
