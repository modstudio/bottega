import { isAbsolute, resolve } from 'node:path'

// This module knows how note anchors and triage determine staleness. It must not
// know about databases, the project register, processes, clocks, or the filesystem.

export type StalenessAnchor = {
  cwd: string
  project: string
  files: Array<{ path: string; line: number; content: string }>
  run_id: number | null
  run_record_id?: string | null
  branch: string | null
  commit: string | null
  session_id: string | null
}

export type StalenessProject = { name: string; path: string; trunk: string }

export type NoteStalenessFacts = {
  note: {
    project: string
    anchors: StalenessAnchor[]
    promotedTask: string | null
    staleAt: string | null
    staleReason: string | null
  }
  acknowledgementSessions: string[]
  existingRuns: Set<string>
  projects: StalenessProject[]
  git(cwd: string, ...args: string[]): string | null
  readFile(path: string): string | null
}

export type NoteStalenessOutcome =
  | { action: 'unchanged'; reason: string | null }
  | { action: 'annotate'; reason: string }
  | { action: 'mark'; reason: string }
  | { action: 'restore'; reason: string | null }

function fileVanishedReason(
  anchor: StalenessAnchor,
  readFile: NoteStalenessFacts['readFile'],
): string | null {
  for (const file of anchor.files) {
    const path = isAbsolute(file.path) ? file.path : resolve(anchor.cwd, file.path)
    const contents = readFile(path)
    if (contents === null) return `${file.path}:${file.line} no longer exists`
    const anchored = file.content.trim()
    if (anchored && !contents.split(/\r?\n/).some((line) => line.trim() === anchored))
      return `${file.path}:${file.line} no longer has its anchored content`
  }
  return null
}

function anchorVanishedReason(anchor: StalenessAnchor, facts: NoteStalenessFacts): string | null {
  const projectName = anchor.project || facts.note.project
  const project = facts.projects.find((candidate) => candidate.name === projectName)
  if (!project) return null
  const fileReason = fileVanishedReason(anchor, facts.readFile)
  if (fileReason) return fileReason
  if (anchor.run_record_id && !facts.existingRuns.has(anchor.run_record_id))
    return `run ${anchor.run_id ?? anchor.run_record_id} aged out`
  if (anchor.branch && anchor.branch !== project.trunk) {
    if (!facts.git(project.path, 'show-ref', '--verify', `refs/heads/${anchor.branch}`))
      return `branch ${anchor.branch} was deleted`
    if (
      facts.git(project.path, 'merge-base', '--is-ancestor', anchor.branch, project.trunk) !== null
    )
      return `branch ${anchor.branch} landed on ${project.trunk}`
  }
  return null
}

function vanishedReason(facts: NoteStalenessFacts): string | null {
  const reasons = facts.note.anchors.map((anchor) => anchorVanishedReason(anchor, facts))
  return reasons.length && reasons.every(Boolean) ? (reasons[reasons.length - 1] ?? null) : null
}

function isTriaged(facts: NoteStalenessFacts): boolean {
  if (facts.note.promotedTask || facts.note.staleReason?.startsWith('dropped:')) return true
  const reporters = new Set(
    facts.note.anchors.flatMap((anchor) => (anchor.session_id ? [anchor.session_id] : [])),
  )
  return facts.acknowledgementSessions.some((session) => !reporters.has(session))
}

export function evaluateNoteStaleness(facts: NoteStalenessFacts): NoteStalenessOutcome {
  const reason = vanishedReason(facts)
  const dropped = facts.note.staleReason?.startsWith('dropped:') ?? false
  if (dropped) return { action: 'unchanged', reason: facts.note.staleReason }
  const triaged = isTriaged(facts)

  if (facts.note.staleAt) {
    if (!reason || !triaged) return { action: 'restore', reason }
    return { action: 'unchanged', reason }
  }
  if (reason) return triaged ? { action: 'mark', reason } : { action: 'annotate', reason }
  if (!triaged && facts.note.staleReason) return { action: 'restore', reason: null }
  return { action: 'unchanged', reason: facts.note.staleReason }
}
