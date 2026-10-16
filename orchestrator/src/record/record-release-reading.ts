// concern: record-release-reading
/** Decides how hosted release rows are presented. Must not know SQL or HTTP. */
export type RecordRelease = {
  id: string
  rung: string
  candidateCommit: string
  liveCommitBefore: string | null
  liveCommitAfter: string | null
  rollback: boolean
  rollbackReason: string | null
  actor: string
  sessionId: string | null
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  liveMatchesCandidate: boolean | null
  warning: string | null
}

export type LatestRecordRelease = {
  rung: string
  lastGood: RecordRelease | null
  latestAttempt: RecordRelease | null
}

function newest(first: RecordRelease, second: RecordRelease): RecordRelease {
  const byStartedAt = first.startedAt.localeCompare(second.startedAt)
  if (byStartedAt !== 0) return byStartedAt > 0 ? first : second
  return first.id.localeCompare(second.id) > 0 ? first : second
}

export function latestRecordReleases(rows: RecordRelease[]): LatestRecordRelease[] {
  const releases = new Map<string, { latest: RecordRelease; lastGood: RecordRelease | null }>()
  for (const row of rows) {
    const current = releases.get(row.rung)
    const latest = current ? newest(current.latest, row) : row
    const successful = row.finishedAt !== null && row.exitCode === 0
    const lastGood = successful
      ? current?.lastGood
        ? newest(current.lastGood, row)
        : row
      : (current?.lastGood ?? null)
    releases.set(row.rung, { latest, lastGood })
  }
  return [...releases.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rung, value]) => ({
      rung,
      lastGood: value.lastGood,
      latestAttempt: value.latest.id === value.lastGood?.id ? null : value.latest,
    }))
}
