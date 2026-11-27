/** Applies command-specific source-file updates through the document service. */

import type { DocWriteSpace, DocWriteTarget } from './doc-authoritative-read.ts'
import { readDocForWrite } from './doc-authoritative-read.ts'
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
  selectedSpace?: DocWriteSpace,
  suppliedTarget?: DocWriteTarget,
): ReturnType<typeof setDoc> {
  if (!sourceFileUpdate) return setDoc(input, selectedSpace, suppliedTarget)
  const target =
    suppliedTarget ??
    (await readDocForWrite(
      input.scope,
      input.subject,
      input.slug,
      input.owner ?? null,
      selectedSpace,
    ))
  const prior = target.doc
  return setDoc(
    {
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
    },
    selectedSpace,
    target,
  )
}
