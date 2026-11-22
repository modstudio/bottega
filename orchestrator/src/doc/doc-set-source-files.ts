/** Applies command-specific source-file updates through the document service. */

import { readDoc } from './doc-authoritative-read.ts'
import {
  type DocSourceFileUpdate,
  docSourceFileExpectedRevision,
  docSourceFileUpdateMode,
  mergeDocSourceFiles,
} from './doc-source-files.ts'
import { setDoc } from './docs.ts'

export async function setDocFromCommand(
  input: Parameters<typeof setDoc>[0],
  sourceFileUpdate: DocSourceFileUpdate | undefined,
): ReturnType<typeof setDoc> {
  if (!sourceFileUpdate) return setDoc(input)
  const prior = await readDoc(input.scope, input.subject, input.slug, input.owner ?? null)
  return setDoc({
    ...input,
    expectedRevision: docSourceFileExpectedRevision(
      docSourceFileUpdateMode(sourceFileUpdate),
      prior?.revision ?? undefined,
      input.expectedRevision,
    ),
    sourceFiles: mergeDocSourceFiles(
      prior?.sourceFiles ?? [],
      sourceFileUpdate.given,
      sourceFileUpdate.replace,
    ),
  })
}
