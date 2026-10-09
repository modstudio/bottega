// concern: local-document-audiences-codec
/** Owns the JSON representation of audience sets in the local SQLite store. */
import { type DocAudiences, normalizeDocAudiences } from '../../../shared/docs.ts'

export function decodeStoredDocAudiences(value: string): DocAudiences {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) throw new Error('stored doc audiences must be a JSON array')
  return normalizeDocAudiences(parsed.map(String))
}

export function encodeStoredDocAudiences(value: DocAudiences): string {
  return JSON.stringify(value)
}
