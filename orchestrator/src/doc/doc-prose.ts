// concern: document prose gate
/** Maps a stored document revision to the shared prose gate fields. */

import { assertOrchestratorProse } from '../prose-service.ts'
import type { DocWriteInput } from './doc-article-fields.ts'
import { docProseFields } from './doc-body-prose.ts'
import type { Doc } from './doc-read-store.ts'

export async function assertDocProse(input: DocWriteInput, prior: Doc | null): Promise<void> {
  await assertOrchestratorProse(docProseFields(input, prior))
}
