import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import {
  docForAudience,
  getDocStore,
  listDocMetadataStore,
  listDocsStore,
} from '../../src/doc/doc-read-store.ts'
import {
  diffStoredDocRevisions,
  getStoredDocRevision,
  listStoredDocRevisions,
} from '../../src/doc/doc-revision-store.ts'

export const getDoc: typeof getDocStore = (...args) => getDocStore(...args)
export const getDocRevision: typeof getStoredDocRevision = (...args) =>
  getStoredDocRevision(...args)
export const listDocMetadata: typeof listDocMetadataStore = (...args) =>
  listDocMetadataStore(...args)
export const listDocRevisions: typeof listStoredDocRevisions = (...args) =>
  listStoredDocRevisions(...args)
export const listDocs: typeof listDocsStore = (...args) => listDocsStore(...args)
export const diffDocRevisions: typeof diffStoredDocRevisions = (...args) =>
  diffStoredDocRevisions(...args)

export function readDocRevision(
  scope: string,
  subject: string | null,
  slug: string,
  recordId: string,
  owner: string | null = null,
  audience?: Parameters<typeof docForAudience>[1],
) {
  const revision = getStoredDocRevision(recordId, owner)
  if (
    !revision ||
    revision.scope !== scope ||
    revision.subject !== subject ||
    revision.slug !== slug
  )
    throw new Error(
      `revision ${recordId} does not belong to ${scope}/${subject ?? '_'}/${slug}; run ${PLATFORM_SLUG} doc history ${scope} ${subject ?? '-'} ${slug}`,
    )
  return audience
    ? docForAudience(
        revision,
        audience,
        `${scope}/${subject ?? '_'}/${slug} revision ${revision.number}`,
      )
    : revision
}
