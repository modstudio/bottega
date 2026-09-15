import { useSyncExternalStore } from 'react'

export type WindowHours = 24 | 48 | 168 | 720
export type WorkFilters = { agent: string; project: string; source: string }
export type WorkCounts = { flight: number; done: number; runs: number }

type WindowState = {
  hours: WindowHours
  filters: WorkFilters
  counts: WorkCounts | null
}

const listeners = new Set<() => void>()
const validHours: readonly number[] = [24, 48, 168, 720]
let state: WindowState = {
  hours: 48,
  filters: { agent: '', project: '', source: '' },
  counts: null,
}

try {
  const hours = Number(localStorage.getItem('hub-hours'))
  const saved = JSON.parse(localStorage.getItem('hub-run-filters') || '{}') as Record<
    string,
    unknown
  >
  state = {
    ...state,
    hours: validHours.includes(hours) ? (hours as WindowHours) : 48,
    filters: {
      agent: typeof saved.agent === 'string' ? saved.agent : '',
      project: typeof saved.project === 'string' ? saved.project : '',
      source: typeof saved.source === 'string' ? saved.source : '',
    },
  }
} catch {
  // Storage is optional; the in-memory state remains usable when it is blocked.
}

function emit() {
  for (const listener of listeners) listener()
}

export function setHours(hours: WindowHours) {
  state = { ...state, hours }
  try {
    localStorage.setItem('hub-hours', String(hours))
  } catch {
    /* optional */
  }
  emit()
}

export function setFilter(key: keyof WorkFilters, value: string) {
  state = { ...state, filters: { ...state.filters, [key]: value } }
  try {
    localStorage.setItem('hub-run-filters', JSON.stringify(state.filters))
  } catch {
    /* optional */
  }
  emit()
}

export function clearFilters() {
  state = { ...state, filters: { agent: '', project: '', source: '' } }
  try {
    localStorage.setItem('hub-run-filters', JSON.stringify(state.filters))
  } catch {
    /* optional */
  }
  emit()
}

export function setWorkCounts(counts: WorkCounts) {
  if (
    state.counts &&
    state.counts.flight === counts.flight &&
    state.counts.done === counts.done &&
    state.counts.runs === counts.runs
  )
    return
  state = { ...state, counts }
  emit()
}

export function useWindowState() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
    () => state,
  )
}

// The Runs view was written against these names at the same time as the work
// views were written against the ones above; both stores were one store by design.
export const WINDOWS = [24, 48, 168, 720] as const
export const setWindowHours = setHours
export const setRunFilter = setFilter
export const clearRunFilters = clearFilters
