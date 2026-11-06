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

function hideContextByDefault(filters: DocListFilters): DocListFilters {
  if (filters.scope !== undefined || filters.scopes !== undefined) return filters
  return {
    ...filters,
    scopes: [
      'project',
      'machine',
      'agent',
      'job',
      'global',
      'stack',
      'resume',
      'canon',
      'settings',
    ],
  }
}

export function listDocs(filters: DocListFilters = {}) {
  const resolved = resolveListFilters(filters)
  const rows = listDocsStore(resolved)
  return filters.scope === undefined && filters.scopes === undefined
    ? rows.filter((doc) => doc.scope !== 'context')
    : rows
}

export function listDocMetadata(filters: DocListFilters = {}) {
  return listDocMetadataStore(resolveListFilters(hideContextByDefault(filters)))
}
