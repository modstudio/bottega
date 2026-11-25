export type StatusCategory = 'open' | 'active' | 'review' | 'done' | 'dropped'
export type TrackerStates = Record<string, StatusCategory | 'backlog'> | undefined
export const TASK_STATUSES = ['open', 'active', 'review', 'done', 'dropped'] as const
export const LIVE_TASK_STATUS_CATEGORIES = TASK_STATUSES.filter(
  (status): status is Exclude<StatusCategory, 'done' | 'dropped'> =>
    status !== 'done' && status !== 'dropped',
)

function establishedCategory(
  rawStatus: string,
  category: string,
  states: TrackerStates,
): StatusCategory | null {
  const word = rawStatus.toLowerCase()
  if (/review/.test(word) || /blocked|on hold/.test(word)) return 'review'
  const normal = (value: string) => value.toLowerCase().replace(/[ -]+/g, '_')
  const mapped =
    states?.[rawStatus] ??
    states?.[normal(rawStatus)] ??
    states?.[category] ??
    states?.[normal(category)]
  return mapped === 'backlog' ? 'open' : (mapped ?? null)
}

export function categoryForTrackerRead(
  incremental: boolean,
  rawStatus: string | undefined,
  categoryHint: string | undefined,
  fullReadFallbackHint: string | undefined,
  states: TrackerStates,
): StatusCategory | null {
  if (incremental)
    return rawStatus ? establishedCategory(rawStatus, categoryHint ?? '', states) : null
  return fullReadCategory(rawStatus, categoryHint, fullReadFallbackHint, states)
}

export function fullReadCategory(
  rawStatus: string | undefined,
  categoryHint: string | undefined,
  fallbackHint: string | undefined,
  states: TrackerStates,
): StatusCategory {
  return categoryOf(rawStatus ?? '', categoryHint ?? fallbackHint ?? '', states)
}

export function categoryOf(
  rawStatus: string,
  category: string,
  states: TrackerStates,
): StatusCategory {
  return establishedCategory(rawStatus, category, states) ?? 'open'
}
