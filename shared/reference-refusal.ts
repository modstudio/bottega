// concern: record-reference
/** Shared refusal wording for record references at store boundaries. */

export const POINTER_REFERENCE_FORMS =
  'doc:<scope>/<subject-or-_>/<slug>, doc:<UUID>, task:<KEY>, task:<KEY>#comment:<id>, <KEY>/<document number>, a run number, r<number>, run:<number-or-UUID>, a run UUID, #<pull request number>, a GitHub pull-request link, a commit SHA, probe:<UUID>, exec:<UUID>, review-read:<UUID>, or attached-text:<UUID>'

export const NOTE_REFERENCE_FORMS =
  'n<number>, a number, <project>#<number>, <project>#n<number>, or a UUID'

export function malformedReferenceRefusal(
  reference: string,
  forms = POINTER_REFERENCE_FORMS,
): string {
  return `reference ${JSON.stringify(reference)} is malformed; pass ${forms}`
}

export function referenceNotVisibleRefusal(scope: string, remedy?: string): string {
  return `reference is not visible in ${scope}${remedy ? `; ${remedy}` : ''}`
}

export function referenceStoreUnreachableRefusal(store: string, detail?: string): string {
  return `could not reach ${store}${detail ? ` (${detail})` : ''}; retry once ${store} answers`
}
