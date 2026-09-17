import {
  consumeDoc as consumeDocument,
  removeDoc as deleteDoc,
  importDocs as readDocs,
  setDoc as writeDoc,
} from '../../src/doc/docs.ts'

export type TestDocInput = Parameters<typeof writeDoc>[0]
export const setDoc = (input: Omit<TestDocInput, 'reason'> & { reason?: string }) =>
  writeDoc({
    ...input,
    delivery:
      input.delivery ??
      (input.scope === 'project' || input.scope === 'global' ? 'demand' : undefined),
    reason: input.reason ?? 'test write',
  })
export const consumeDoc = (
  scope: string,
  subject: string | null,
  slug: string,
  context: { reason: string; author?: string } = { reason: 'test consume' },
) => consumeDocument(scope, subject, slug, context)
export const removeDoc = (
  scope: string,
  subject: string | null,
  slug: string,
  context: { reason: string; author?: string } = { reason: 'test delete' },
) => deleteDoc(scope, subject, slug, context)
export const importDocs = (dir: string, context = { reason: 'test import' }) =>
  readDocs(dir, context)
