// concern: record-cache
/** Collects and reports hosted document links that a cache pull cannot apply yet. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { recordDocList } from './record-doc-list-shape.ts'

export type SubjectDeferrals = Map<string, Set<string>>
export type DocPullResult = {
  docs: number
  skippedDocs: number
  unresolvedParents: Map<string, string>
  subjectDeferrals: SubjectDeferrals
}
export type DocDeferrals = Pick<DocPullResult, 'unresolvedParents' | 'subjectDeferrals'>
export type ReadonlyDocDeferrals = {
  readonly unresolvedParents: ReadonlyMap<string, string>
  readonly subjectDeferrals: ReadonlyMap<string, ReadonlySet<string>>
}
export type DocApplyOutcome = 'applied' | 'deferred' | 'deleted'
export type WaitingOnUnregisteredProject = {
  docId: string
  subjectId: string
  project: string
}

export function classifyRecordCacheSubjectDeferrals(
  subjectDeferrals: ReadonlyMap<string, ReadonlySet<string>>,
  hostedSubjectProjects: ReadonlyMap<string, string>,
  projectSpaces: ReadonlyMap<string, string | null>,
): {
  waitingOnUnregistered: WaitingOnUnregisteredProject[]
  refusing: SubjectDeferrals
} {
  const waitingOnUnregistered: WaitingOnUnregisteredProject[] = []
  const refusing: SubjectDeferrals = new Map()
  for (const [docId, subjectIds] of subjectDeferrals) {
    for (const subjectId of subjectIds) {
      const project = hostedSubjectProjects.get(subjectId)
      if (project !== undefined && !projectSpaces.has(project)) {
        waitingOnUnregistered.push({ docId, subjectId, project })
        continue
      }
      const subjects = refusing.get(docId) ?? new Set<string>()
      subjects.add(subjectId)
      refusing.set(docId, subjects)
    }
  }
  return { waitingOnUnregistered, refusing }
}

export function hasDocDeferrals(input: ReadonlyDocDeferrals): boolean {
  return input.unresolvedParents.size > 0 || input.subjectDeferrals.size > 0
}

export function recordCacheDocReferencedSubjects(
  item: Record<string, unknown>,
  recordId: string,
): { articleSubjectId: string | null; relatedSubjectIds: string[] } {
  const articleSubjectId =
    item.articleSubject && typeof item.articleSubject === 'object'
      ? String((item.articleSubject as Record<string, unknown>).id)
      : null
  const related = recordDocList(item.relatedSubjects, {
    document: recordId,
    column: 'doc.related_subjects',
    optional: true,
  })
  if (related.unwrapped)
    console.warn(`unwrapped hosted document JSON string list: ${recordId} doc.related_subjects`)
  return {
    articleSubjectId,
    relatedSubjectIds: related.values.map((value) => String((value as Record<string, unknown>).id)),
  }
}

export function recordCacheDocDeferralError(input: ReadonlyDocDeferrals): Error | null {
  const clauses: string[] = []
  if (input.unresolvedParents.size) {
    const links = [...input.unresolvedParents]
      .map(([child, parent]) => `${child} -> ${parent}`)
      .sort()
      .join(', ')
    clauses.push(
      renderRefusal(
        refusal(`record cache could not resolve document parent links ${links}`, {
          kind: 'edit',
          text: 'ensure the hosted parent documents are readable and refresh again',
        }),
      ),
    )
  }
  if (input.subjectDeferrals.size) {
    const links = [...input.subjectDeferrals]
      .flatMap(([doc, subjects]) =>
        [...subjects].map((subject) => `document ${doc}: subject ${subject} is not local`),
      )
      .sort()
      .join(', ')
    clauses.push(
      renderRefusal(
        refusal(`record cache deferred ${links}`, {
          kind: 'edit',
          text: `the subject is not returned by any pulled space; ensure it is readable in this space, then run ${PLATFORM_SLUG} record pull`,
        }),
      ),
    )
  }
  return clauses.length ? new Error(clauses.join('; ')) : null
}
