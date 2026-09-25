import type { Finding } from '../../../shared/ratchet.ts'

export type CanonAuditFinding = Pick<Finding, 'file' | 'line' | 'rule' | 'message'> & {
  project: string
}

export type CanonAuditNote = {
  id: number
  text: string
  stale_at: string | null
  stale_reason: string | null
  promoted_task: string | null
  last_seen_at: string
}

export type CanonAuditFiling = { text: string; sameAs?: number }

export type CanonAuditProjectRead = {
  project: string
  path: string
  findings: Finding[] | null
  notes: CanonAuditNote[] | null
  failures: string[]
}

export type CanonAuditProjectPlan = {
  project: string
  path: string
  findings: number
  notes: CanonAuditFiling[]
}

function canonAuditNoteText(finding: CanonAuditFinding): string {
  return `canon audit: ${finding.project} ${finding.rule} ${finding.file}:${finding.line} ${finding.message}`
}

function canonAuditIdentityKey(finding: Omit<CanonAuditFinding, 'line'>): string {
  return JSON.stringify([finding.project, finding.rule, finding.file, finding.message])
}

function existingNoteIdentityKey(text: string): string | null {
  // Use the first line marker after the rule because messages may themselves contain :<digits>.
  const match = /^canon audit: (\S+) (\S+) (.*?):\d+ (.*)$/.exec(text)
  if (!match) return null
  return JSON.stringify([match[1], match[2], match[3], match[4]])
}

/** Decide exact new-note filings without consulting stores, files, or similarity scores. */
export function decideCanonAuditNotes(
  findings: CanonAuditFinding[],
  existingNotes: CanonAuditNote[],
): CanonAuditFiling[] {
  const notesByKey = Map.groupBy(existingNotes, (note) => existingNoteIdentityKey(note.text))
  const decided = new Set<string>()
  const filings: CanonAuditFiling[] = []
  for (const finding of findings) {
    const text = canonAuditNoteText(finding)
    const key = canonAuditIdentityKey(finding)
    if (decided.has(key)) continue
    decided.add(key)
    const matching = notesByKey.get(key) ?? []
    if (
      matching.some(
        (note) =>
          note.stale_at === null ||
          note.promoted_task !== null ||
          note.stale_reason?.startsWith('dropped:') === true,
      )
    ) {
      continue
    }
    const stale = matching.reduce<CanonAuditNote | null>(
      (latest, note) => (!latest || note.last_seen_at > latest.last_seen_at ? note : latest),
      null,
    )
    filings.push(stale ? { text, sameAs: stale.id } : { text })
  }
  return filings
}

/** Retain every readable project plan and every read failure in one audit. */
export function decideCanonAuditRun(reads: CanonAuditProjectRead[]): {
  plans: CanonAuditProjectPlan[]
  failures: string[]
} {
  const plans: CanonAuditProjectPlan[] = []
  const failures: string[] = []
  for (const read of reads) {
    failures.push(...read.failures)
    if (read.findings === null || read.notes === null) continue
    plans.push({
      project: read.project,
      path: read.path,
      findings: read.findings.length,
      notes: decideCanonAuditNotes(
        read.findings.map((finding) => ({ ...finding, project: read.project })),
        read.notes,
      ),
    })
  }
  return { plans, failures }
}
