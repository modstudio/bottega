// concern: document listing
/** Resolves service-level document filters before querying the local read store. */
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

export function listDocs(filters: DocListFilters = {}) {
  return listDocsStore(resolveListFilters(filters))
}

export function listDocMetadata(filters: DocListFilters = {}) {
  return listDocMetadataStore(resolveListFilters(filters))
}
