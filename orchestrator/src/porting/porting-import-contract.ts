// concern: porting-import-contract
/** Shared shape and refusal contract for local and hosted legacy port imports. */

type ImportIssue = {
  kind: 'refusal' | 'exclusion'
  what: string
  where: string
  why: string
  value?: string
}

export type ImportRefusal = ImportIssue & { kind: 'refusal' }
export type ImportExclusion = ImportIssue & { kind: 'exclusion' }

export type ImportPlan = {
  pairs: { source: string; target: string; sourceId: string; targetId: string }[]
  baselines: { pairKey: string; sourceCommit: string | null; scannedAt: string | null }[]
  skips: { pairKey: string; candidate: string; reason: string }[]
  refs: {
    taskKey: string
    targetProjectId: string
    note: string
    sources: {
      source_project_record_id: string
      commits: string[]
      paths: string[]
      note: string
    }[]
  }[]
  doctrine: { number: number; title: string; body: string }[]
  docs: { scope: string; subject: string | null; slug: string; title: string; body: string }[]
  refusals: ImportRefusal[]
  exclusions: ImportExclusion[]
}

export type ImportFiles = {
  doctrine: string
  differences: string
  backports: string
  refs: string
  state: string
  projects: string
}

export type SourceCoverageGap = { file: string; offset: number; text: string }

export class ImportRefusalError extends Error {
  public refusals: ImportRefusal[]

  constructor(refusals: ImportRefusal[]) {
    super(`port import refused with ${refusals.length} refusal(s)`)
    this.refusals = refusals
  }
}
