// concern: document listing
/** Resolves service-level document filters before querying the local read store. */
import { DOC_SCOPES } from '../../../shared/docs.ts'
import { resolveSubject } from '../subject/subjects.ts'
import { type DocListFilters, listDocMetadataStore, listDocsStore } from './doc-read-store.ts'

function resolveListFilters(filters: DocListFilters): DocListFilters {
  if (filters.articleSubject === undefined) return filters
  if (filters.scope !== 'project' || !filters.subject) {
    throw new Error('article subject filter requires project scope and subject')
  }
  return {
    ...filters,
    articleSubject: resolveSubject(filters.subject, filters.articleSubject).id,
  }
}

/** Context items are read through their holder, so an unscoped listing leaves them out. */
function hideContextByDefault(filters: DocListFilters): DocListFilters {
  if (filters.scope !== undefined || filters.scopes !== undefined) return filters
  return { ...filters, scopes: DOC_SCOPES.filter((scope) => scope !== 'context') }
}

export function listDocs(filters: DocListFilters = {}) {
  return listDocsStore(resolveListFilters(hideContextByDefault(filters)))
}

export function listDocMetadata(filters: DocListFilters = {}) {
  return listDocMetadataStore(resolveListFilters(hideContextByDefault(filters)))
}
