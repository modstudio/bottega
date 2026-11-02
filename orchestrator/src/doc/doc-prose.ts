// concern: document prose gate
/** Maps a stored document revision to the shared prose gate fields. */

import { assertOrchestratorProse } from '../prose-service.ts'
import { SETTINGS_SCOPE } from '../settings/settings.ts'
import type { DocWriteInput } from './doc-article-fields.ts'
import type { Doc } from './doc-read-store.ts'

export function docBodyIsProse(scope: string): boolean {
  return scope !== SETTINGS_SCOPE
}

export async function assertDocProse(input: DocWriteInput, prior: Doc | null): Promise<void> {
  const fields = [
    { field: 'title', text: input.title, prior: prior?.title ?? null },
    { field: 'summary', text: input.summary ?? '', prior: prior?.summary ?? null },
  ]
  if (docBodyIsProse(input.scope)) {
    fields.push({ field: 'body', text: input.body, prior: prior?.body ?? null })
  }
  await assertOrchestratorProse(fields)
}
