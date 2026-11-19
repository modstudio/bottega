// concern: record-cache-deferred-fallbacks
/** Keeps deferred docs scheduled and classifies their hosted subject ownership. */
import type { Database } from 'bun:sqlite'
import type { RecordApiClient } from './record-api-client.ts'
import {
  classifyRecordCacheSubjectDeferrals,
  type DocDeferrals,
  hasDocDeferrals,
  type ReadonlyDocDeferrals,
  type SubjectDeferrals,
  type WaitingOnUnregisteredProject,
} from './record-cache-doc-deferrals.ts'
import {
  pendingRecordCacheFallbacks,
  recordCacheFallbackKey,
  recordCacheFallbackSpace,
  writePendingRecordCacheFallbacks,
} from './record-cache-fallbacks.ts'

export type DeferredDocFallbacks = Map<string, DocDeferrals>

function combinedDocDeferrals(deferred: DeferredDocFallbacks): DocDeferrals {
  const unresolvedParents = new Map<string, string>()
  const subjectDeferrals: SubjectDeferrals = new Map()
  for (const pulled of deferred.values()) {
    for (const [child, parent] of pulled.unresolvedParents) unresolvedParents.set(child, parent)
    for (const [doc, subjects] of pulled.subjectDeferrals)
      subjectDeferrals.set(doc, new Set(subjects))
  }
  return { unresolvedParents, subjectDeferrals }
}

export function rememberKeysetDocDeferrals(
  deferred: DeferredDocFallbacks,
  spaces: readonly string[],
  pulled: DocDeferrals,
  local: Database,
): void {
  if (!hasDocDeferrals(pulled)) return
  const pending = pendingRecordCacheFallbacks(local)
  for (const space of spaces) {
    const key = recordCacheFallbackKey('doc', space)
    deferred.set(key, pulled)
    pending.add(key)
  }
  writePendingRecordCacheFallbacks(local, pending)
}

export async function classifyDeferredDocFallbacks(
  deferred: DeferredDocFallbacks,
  client: Pick<RecordApiClient, 'listProjectSubjects'>,
  projectSpaces: ReadonlyMap<string, string | null>,
): Promise<{
  deferrals: ReadonlyDocDeferrals
  waitingOnUnregistered: WaitingOnUnregisteredProject[]
  listingError: Error | null
}> {
  const combined = combinedDocDeferrals(deferred)
  const hostedSubjectProjects = new Map<string, string>()
  const spaces = new Set<string>()
  for (const [fallback, value] of deferred)
    if (value.subjectDeferrals.size) spaces.add(recordCacheFallbackSpace(fallback))
  try {
    for (const space of spaces) {
      let cursor: string | undefined
      for (;;) {
        const page = await client.listProjectSubjects(
          { includeRetired: true, cursor, limit: 100 },
          { destinationSpaceId: space },
        )
        for (const subject of page.items) hostedSubjectProjects.set(subject.id, subject.project)
        if (!page.nextCursor) break
        cursor = page.nextCursor
      }
    }
  } catch (error) {
    return {
      deferrals: combined,
      waitingOnUnregistered: [],
      listingError: error instanceof Error ? error : new Error(String(error)),
    }
  }
  const classified = classifyRecordCacheSubjectDeferrals(
    combined.subjectDeferrals,
    hostedSubjectProjects,
    projectSpaces,
  )
  return {
    deferrals: {
      unresolvedParents: combined.unresolvedParents,
      subjectDeferrals: classified.refusing,
    },
    waitingOnUnregistered: classified.waitingOnUnregistered,
    listingError: null,
  }
}
