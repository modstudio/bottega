// concern: record-reference
/** Shared refusal wording for record references at store boundaries. */

import { POINTER_REFERENCE_FORMS } from './reference.ts'

export function malformedReferenceRefusal(reference: string): string {
  return `reference ${JSON.stringify(reference)} is malformed; pass ${POINTER_REFERENCE_FORMS}`
}

export function referenceNotVisibleRefusal(scope: string, remedy?: string): string {
  return `reference is not visible in ${scope}${remedy ? `; ${remedy}` : ''}`
}

export function referenceStoreUnreachableRefusal(store: string, detail?: string): string {
  return `could not reach ${store}${detail ? ` (${detail})` : ''}; retry once ${store} answers`
}
