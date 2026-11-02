// concern: document prose policy
/** Decides whether a document body is prose or a machine-structured payload. */

import { SETTINGS_SCOPE } from '../settings/settings.ts'

export function docBodyIsProse(scope: string): boolean {
  return scope !== SETTINGS_SCOPE
}

type DocProseText = { scope: string; title: string; summary?: string | null; body: string }
type PriorDocProseText = Omit<DocProseText, 'scope'>

export function docProseFields(input: DocProseText, prior: PriorDocProseText | null) {
  const fields = [
    { field: 'title', text: input.title, prior: prior?.title ?? null },
    { field: 'summary', text: input.summary ?? '', prior: prior?.summary ?? null },
  ]
  if (docBodyIsProse(input.scope)) {
    fields.push({ field: 'body', text: input.body, prior: prior?.body ?? null })
  }
  return fields
}
