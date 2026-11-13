import { getContextItem } from '../../src/doc/context-item-store.ts'
import { setContextItem } from '../../src/doc/context-service.ts'
import {
  consumeDoc as consumeDocument,
  removeDoc as deleteDoc,
  importDocs as readDocs,
  setDoc as writeDoc,
} from '../../src/doc/docs.ts'
import { decodeContextItem } from './context-item.ts'

type TestDocInput = Parameters<typeof writeDoc>[0]
type TestDocWriteInput = Omit<TestDocInput, 'reason' | 'scope'> & {
  scope: string
  reason?: string
}
export const setDoc = async (input: TestDocWriteInput): ReturnType<typeof writeDoc> => {
  if (input.scope === 'context') {
    const holder = input.subject ?? ''
    const legacy = decodeContextItem(input.body)
    const written = await setContextItem({
      ...(holder.startsWith('session:') ? { session: holder.slice(8) } : {}),
      id: input.slug,
      kind: legacy.kind,
      source: legacy.source,
      body: legacy.body,
      expectedRevision: input.expectedRevision,
    })
    const stored = getContextItem(holder, input.slug)!
    return {
      ...written,
      record_id: stored.recordId,
      updated_at: stored.updatedAt,
    } as unknown as Awaited<ReturnType<typeof writeDoc>>
  }
  return writeDoc({
    ...input,
    delivery:
      input.delivery ??
      (input.scope === 'project' || input.scope === 'global' ? 'demand' : undefined),
    reason: input.reason ?? 'test write',
  })
}
export const consumeDoc = (
  scope: string,
  subject: string | null | undefined,
  slug: string,
  context: { reason: string; author?: string } = { reason: 'test consume' },
) => consumeDocument(scope, subject, slug, context)
export const removeDoc = (
  scope: string,
  subject: string | null,
  slug: string,
  context: Parameters<typeof deleteDoc>[3] = { reason: 'test delete' },
) => deleteDoc(scope, subject, slug, context)
export const importDocs = (dir: string, context = { reason: 'test import' }) =>
  readDocs(dir, context)

export const resume =
  '---\nstatus: open\nepic: DEV-1439\nproject: known\nwritten: 2026-10-20T12:00:00.000Z\n---\n\nNEXT ACTION: continue\n'
