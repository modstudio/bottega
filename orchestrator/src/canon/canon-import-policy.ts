// concern: canon-import-policy
/** Decides one complete canon import without knowing stores, transports, or commands. */

import { composeCanonRows } from './canon-hydrate.ts'
import type { CanonFinding, CanonSourceText } from './canon-lint.ts'
import {
  decideNextCanonSet,
  decideUserCanonImport,
  type WorkflowStepBody,
} from './canon-write-gate.ts'
import { isUserCanonSlug, userCanonHomeImportDeletionSlugs } from './user-canon-home.ts'

type Row = { slug: string; body: string }

export type CanonImportAddress = { kind: 'user' } | { kind: 'project' }

export type CanonImportPlan = {
  bootstrap: boolean
  deletionSlugs: string[]
  findings: CanonFinding[]
  refusal: 'empty' | 'findings' | null
}

/** Applies the same next-set, bootstrap, deletion, and findings policy at every import boundary. */
export function planCanonImport(input: {
  address: CanonImportAddress
  current: Row[]
  desired: Row[]
  hasHistory: boolean
  surroundings?: Array<{ global: Row[]; project: Row[] }>
  trackedPaths?: string[]
  packageScripts?: string[]
  sourceTexts?: CanonSourceText[]
  workflowSteps?: WorkflowStepBody[]
}): CanonImportPlan {
  const desiredSlugs = new Set(input.desired.map(({ slug }) => slug))
  const deletionSlugs =
    input.address.kind === 'user'
      ? userCanonHomeImportDeletionSlugs(
          input.current.map(({ slug }) => slug),
          desiredSlugs,
        )
      : input.current.map(({ slug }) => slug).filter((slug) => !desiredSlugs.has(slug))
  const bootstrap = !input.hasHistory
  const surroundings = input.surroundings ?? [{ global: [], project: [] }]
  const findings =
    input.address.kind === 'user'
      ? decideUserCanonImport({
          current: input.current,
          next: [...input.current.filter(({ slug }) => !isUserCanonSlug(slug)), ...input.desired],
          surroundings,
        }).findings
      : decideNextCanonSet({
          current: composeCanonRows(
            (surroundings[0]?.global ?? []).map((row) => ({ ...row, subject: null })),
            [],
            input.current.map((row) => ({ ...row, subject: 'project' })),
          ),
          next: composeCanonRows(
            (surroundings[0]?.global ?? []).map((row) => ({ ...row, subject: null })),
            [],
            input.desired.map((row) => ({ ...row, subject: 'project' })),
          ),
          trackedPaths: input.trackedPaths,
          packageScripts: input.packageScripts,
          sourceTexts: input.sourceTexts,
          workflowSteps: input.workflowSteps,
        })
  return {
    bootstrap,
    deletionSlugs,
    findings,
    refusal:
      input.desired.length === 0 ? 'empty' : !bootstrap && findings.length ? 'findings' : null,
  }
}
