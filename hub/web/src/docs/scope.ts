import { DOC_SCOPES, type DocScope } from '../../../../shared/docs.ts'

export function isScope(value: string): value is DocScope {
  return (DOC_SCOPES as readonly string[]).includes(value)
}
