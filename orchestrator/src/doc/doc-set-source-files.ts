/** Applies command-specific source-file updates through the document service. */

import { type DocSourceFileUpdate, mergeDocSourceFiles } from './doc-source-files.ts'
import { getDoc, setDoc } from './docs.ts'

export async function setDocFromCommand(
  input: Parameters<typeof setDoc>[0],
  sourceFileUpdate: DocSourceFileUpdate | undefined,
): ReturnType<typeof setDoc> {
  if (!sourceFileUpdate) return setDoc(input)
  const prior = getDoc(input.scope, input.subject, input.slug, input.owner ?? null)
  return setDoc({
    ...input,
    sourceFiles: mergeDocSourceFiles(
      prior?.sourceFiles ?? [],
      sourceFileUpdate.given,
      sourceFileUpdate.replace,
    ),
  })
}
