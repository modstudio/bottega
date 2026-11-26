// concern: note class report
/** Reads one evaluation revision and renders its ranked classes. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { readNoteEvaluationRevision } from './note-curator-orch.ts'
import {
  formatClassRanking,
  NOTE_EVALUATION_RECORD_SLUG,
  parseCurationRecord,
} from './note-evaluation-record.ts'
import { docList } from './orch.ts'

type Dependencies = {
  list: typeof docList
  revision: typeof readNoteEvaluationRevision
}

export async function readNoteClasses(
  input: { project: string; revision?: string },
  dependencies: Dependencies = { list: docList, revision: readNoteEvaluationRevision },
): Promise<string> {
  const current = (await dependencies.list({ scope: 'project', subject: input.project })).find(
    (document) => document.slug === NOTE_EVALUATION_RECORD_SLUG,
  )
  if (!current)
    throw new Error(
      `no note evaluation record for ${input.project}; run ${PLATFORM_SLUG} note evaluate --project ${input.project}`,
    )
  const document = input.revision
    ? await dependencies.revision(input.project, input.revision)
    : current
  const data = parseCurationRecord(document.body)
  if (!data)
    throw new Error(
      `note evaluation revision has no class ranking; run ${PLATFORM_SLUG} note evaluate --project ${input.project}`,
    )
  return formatClassRanking(data)
}
