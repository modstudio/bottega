// This module knows how observed note anchors and triage determine staleness. It
// must not know about databases, the project register, processes, clocks, or the filesystem.

export type StalenessAnchorObservation = {
  sessionId: string | null
  projectFound: boolean
  files: Array<{
    path: string
    line: number
    exists: boolean
    containsAnchoredContent: boolean
  }>
  run: { label: number | string; exists: boolean } | null
  branch: {
    name: string
    trunk: string
    exists: boolean
    landed: boolean
  } | null
}

export type NoteStalenessFacts = {
  note: {
    anchors: StalenessAnchorObservation[]
    promotedTask: string | null
    staleAt: string | null
    staleReason: string | null
  }
  acknowledgementSessions: string[]
}

export type NoteStalenessOutcome =
  | { action: 'unchanged'; reason: string | null; triaged: boolean }
  | { action: 'annotate'; reason: string; triaged: boolean }
  | { action: 'mark'; reason: string; triaged: boolean }
  | { action: 'restore'; reason: string | null; triaged: boolean }

function anchorVanishedReason(anchor: StalenessAnchorObservation): string | null {
  if (!anchor.projectFound) return null
  for (const file of anchor.files) {
    if (!file.exists) return `${file.path}:${file.line} no longer exists`
    if (!file.containsAnchoredContent)
      return `${file.path}:${file.line} no longer has its anchored content`
  }
  if (anchor.run && !anchor.run.exists) return `run ${anchor.run.label} aged out`
  if (anchor.branch) {
    if (!anchor.branch.exists) return `branch ${anchor.branch.name} was deleted`
    if (anchor.branch.landed) return `branch ${anchor.branch.name} landed on ${anchor.branch.trunk}`
  }
  return null
}

function vanishedReason(facts: NoteStalenessFacts): string | null {
  const reasons = facts.note.anchors.map(anchorVanishedReason)
  return reasons.length && reasons.every(Boolean) ? (reasons[reasons.length - 1] ?? null) : null
}

function noteIsTriaged(facts: NoteStalenessFacts): boolean {
  if (facts.note.promotedTask || facts.note.staleReason?.startsWith('dropped:')) return true
  const reporters = new Set(
    facts.note.anchors.flatMap((anchor) => (anchor.sessionId ? [anchor.sessionId] : [])),
  )
  return facts.acknowledgementSessions.some((session) => !reporters.has(session))
}

export function evaluateNoteStaleness(facts: NoteStalenessFacts): NoteStalenessOutcome {
  const reason = vanishedReason(facts)
  const triaged = noteIsTriaged(facts)
  if (facts.note.staleReason?.startsWith('dropped:'))
    return { action: 'unchanged', reason: facts.note.staleReason, triaged }

  if (facts.note.staleAt) {
    if (!reason || !triaged) return { action: 'restore', reason, triaged }
    return { action: 'unchanged', reason, triaged }
  }
  if (reason) {
    if (triaged) return { action: 'mark', reason, triaged }
    if (facts.note.staleReason === reason) return { action: 'unchanged', reason, triaged }
    return { action: 'annotate', reason, triaged }
  }
  if (!triaged && facts.note.staleReason) return { action: 'restore', reason: null, triaged }
  return { action: 'unchanged', reason: facts.note.staleReason, triaged }
}
