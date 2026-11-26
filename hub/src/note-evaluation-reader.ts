// concern: note evaluation reader
/** Reads the current or one named revision of a project's evaluation record. */

import { NOTE_EVALUATION_RECORD_SLUG } from './note-evaluation-identity.ts'
import { docList } from './orch.ts'
import { docRevision } from './orch-doc-revision.ts'

type EvaluationDocument = { body: string }

type Dependencies = {
  list: typeof docList
  revision: typeof docRevision
}

const dependencies: Dependencies = { list: docList, revision: docRevision }

export async function readNoteEvaluationRecord(
  project: string,
  revision?: string,
  deps: Dependencies = dependencies,
): Promise<EvaluationDocument | null> {
  if (revision) return deps.revision('project', project, NOTE_EVALUATION_RECORD_SLUG, revision)
  return (
    (await deps.list({ scope: 'project', subject: project })).find(
      (document) => document.slug === NOTE_EVALUATION_RECORD_SLUG,
    ) ?? null
  )
}
