// concern: document listing
/** Resolves service-level document filters before querying the local read store. */
import { resolveLocalDocListFilters } from './doc-article-fields.ts'
import { type DocListFilters, listDocMetadataStore, listDocsStore } from './doc-read-store.ts'

export function listDocs(filters: DocListFilters = {}) {
  return listDocsStore(resolveLocalDocListFilters(filters))
}

export function listDocMetadata(filters: DocListFilters = {}) {
  return listDocMetadataStore(resolveLocalDocListFilters(filters))
}
