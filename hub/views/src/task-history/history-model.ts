/**
 * One thing that happened to a task, in the shape the history feed draws. The actor is the person
 * it was done for, null when the record does not say; agent names the agent that did it for them.
 */
export type HistoryEntry =
  | {
      kind: 'comment'
      id: string
      at: string
      body: string
      actor?: string | null
      agent?: string | null
      /** Whether this reader may edit or delete it; the screen's data decides. */
      canEdit?: boolean
      canDelete?: boolean
    }
  | {
      kind: 'status'
      id: string
      at: string
      from: string | null
      to: string
      actor?: string | null
      agent?: string | null
    }
  | {
      kind: 'run'
      id: string
      at: string
      run: string | null
      agent: string | null
      job: string | null
      endedAt: string | null
      running: boolean
      actor?: string | null
    }

export type HistoryKind = HistoryEntry['kind']
export type HistoryFilter = 'all' | HistoryKind

/** Consecutive status changes drawn as one line, oldest change first. */
export type StatusRun = { kind: 'status-run'; id: string; at: string; changes: HistoryEntry[] }
export type HistoryItem = Exclude<HistoryEntry, { kind: 'status' }> | StatusRun
/** One person's consecutive events, newest first, with adjacent status changes folded. */
export type ActorCluster = { id: string; actor: string | null; items: HistoryItem[] }
export type HistoryDay = { key: string; label: string; clusters: ActorCluster[] }

const time = (value: string) => new Date(value).getTime()

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/** "Today", "Yesterday", then a short date, with the year only outside the current one. */
export function historyDayLabel(at: string, now: Date): string {
  const date = new Date(at)
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (dayKey(date) === dayKey(now)) return 'Today'
  if (dayKey(date) === dayKey(yesterday)) return 'Yesterday'
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(date)
}

/** The kinds present, in the order the filter offers them. */
export function historyKinds(entries: readonly HistoryEntry[]): HistoryKind[] {
  const present = new Set(entries.map((entry) => entry.kind))
  return (['comment', 'status', 'run'] as const).filter((kind) => present.has(kind))
}

/** Adds an entry to a cluster, folding a status change into an adjacent status run. */
function addToCluster(cluster: ActorCluster, entry: HistoryEntry) {
  const last = cluster.items.at(-1)
  if (entry.kind === 'status' && last?.kind === 'status-run') last.changes.unshift(entry)
  else if (entry.kind === 'status')
    cluster.items.push({ kind: 'status-run', id: entry.id, at: entry.at, changes: [entry] })
  else cluster.items.push(entry)
}

/**
 * Newest first, bucketed by local day. Within a day, one person's consecutive events gather into a
 * cluster whichever agents did them, so the person is named again only when the person or the day
 * changes. Status changes next to each other in a cluster fold into one run.
 */
export function groupHistory(
  entries: readonly HistoryEntry[],
  filter: HistoryFilter,
  now: Date,
): HistoryDay[] {
  const shown = entries
    .filter((entry) => filter === 'all' || entry.kind === filter)
    .sort((left, right) => time(right.at) - time(left.at) || right.id.localeCompare(left.id))
  const days: HistoryDay[] = []
  for (const entry of shown) {
    const key = dayKey(new Date(entry.at))
    let day = days.at(-1)
    if (!day || day.key !== key) {
      day = { key, label: historyDayLabel(entry.at, now), clusters: [] }
      days.push(day)
    }
    const actor = entry.actor ?? null
    let cluster = day.clusters.at(-1)
    if (!cluster || cluster.actor !== actor) {
      cluster = { id: entry.id, actor, items: [] }
      day.clusters.push(cluster)
    }
    addToCluster(cluster, entry)
  }
  return days
}

/**
 * The statuses a run of changes passed through, oldest first, without repeats in a row. Each step
 * is keyed by the change that reached it, because a path can revisit a status.
 */
export function statusPath(changes: readonly HistoryEntry[]): { key: string; status: string }[] {
  const path: { key: string; status: string }[] = []
  for (const change of changes) {
    if (change.kind !== 'status') continue
    if (!path.length && change.from) path.push({ key: `${change.id}:from`, status: change.from })
    if (path.at(-1)?.status !== change.to) path.push({ key: change.id, status: change.to })
  }
  return path
}

/** A run's length as minutes, hours and minutes, or seconds when under a minute. */
export function runDuration(startedAt: string, endedAt: string | null): string | null {
  if (!endedAt) return null
  const seconds = Math.max(0, Math.round((time(endedAt) - time(startedAt)) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
