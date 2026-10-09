// concern: record-doc-audiences
/** Decodes the Postgres text[] representation used by hosted document rows. */
import { type DocAudiences, normalizeDocAudiences } from '../../../shared/docs.ts'

export function recordDocAudiences(value: unknown): DocAudiences {
  if (!Array.isArray(value)) throw new Error('hosted doc audiences must be a Postgres text array')
  return normalizeDocAudiences(value.map(String))
}
