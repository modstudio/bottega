/**
 * Engaged time, counted once however many agents were working.
 *
 * The whole reason this module exists in one sentence: while a delegated agent
 * runs, Claude is idle and the work is not. Summing per-agent durations
 * double-counts every parallel fan-out; measuring only Claude's own message
 * gaps reports near-zero for a stretch where three agents were reading the
 * codebase. Neither is the number anyone wants, and the union of half-open
 * spans is.
 */
export type Span = { start: number; end: number }

/**
 * Merge overlapping and touching spans.
 *
 * Touching spans are merged too (`end === start`): a run that finishes at the
 * exact millisecond the next message lands is continuous work, and leaving a
 * zero-width seam between them would only add rows without adding time.
 */
export function union(spans: Span[]): Span[] {
  if (spans.length === 0) return []
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Span[] = [{ ...sorted[0]! }]
  for (const s of sorted.slice(1)) {
    const last = out[out.length - 1]!
    if (s.start <= last.end) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** Total milliseconds covered by the union of `spans`. */
export function engagedMs(spans: Span[]): number {
  return union(spans).reduce((sum, s) => sum + (s.end - s.start), 0)
}

/** Milliseconds of the union that fall inside `[from, to)`. */
export function engagedMsWithin(spans: Span[], from: number, to: number): number {
  return union(spans).reduce((sum, s) => {
    const start = Math.max(s.start, from)
    const end = Math.min(s.end, to)
    return sum + Math.max(0, end - start)
  }, 0)
}

/**
 * Turn a session's message timestamps into spans.
 *
 * A transcript records instants, not durations, so a gap has to stand in for
 * the work that happened across it — capped, because an eight-hour gap between
 * two messages is a night's sleep and not a night's work. The cap is the same
 * ten minutes work-report settled on.
 *
 * Capping here rather than at the sum is what makes these unionable: each pair
 * becomes a real span with a real start, so it can overlap an agent run instead
 * of merely adding to it.
 */
export function spansFromTimestamps(ms: number[], idleCapMs: number): Span[] {
  if (ms.length < 2) return []
  const sorted = [...ms].sort((a, b) => a - b)
  const out: Span[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i]!
    const end = Math.min(sorted[i + 1]!, start + idleCapMs)
    if (end > start) out.push({ start, end })
  }
  return out
}

export const DEFAULT_IDLE_CAP_MS = 10 * 60_000

/** `2h 14m`, `7m 30s`, `12s` — the estate's existing duration style. */
export function human(ms: number): string {
  if (ms < 1000) return '0s'
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${sec}s`
  return `${sec}s`
}

