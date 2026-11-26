// concern: note class report
/** Reads one evaluation revision and renders its ranked classes. */

import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { readNoteEvaluationRecord } from './note-evaluation-reader.ts'
import { formatClassRanking, parseCurationRecord } from './note-evaluation-record.ts'

type Reader = typeof readNoteEvaluationRecord

export async function readNoteClasses(
  input: { project: string; revision?: string },
  readRecord: Reader = readNoteEvaluationRecord,
): Promise<string> {
  const document = await readRecord(input.project, input.revision)
  if (!document)
    throw new Error(
      `no note evaluation record for ${input.project}; run ${PLATFORM_SLUG} note evaluate --project ${input.project}`,
    )
  const data = parseCurationRecord(document.body)
  if (!data)
    throw new Error(
      `note evaluation revision has no class ranking; run ${PLATFORM_SLUG} note evaluate --project ${input.project}`,
    )
  if (!data.ranking.length) {
    const recorded = data.stopped
      ? `Curation stopped: ${data.stopped}`
      : `Jev status: ${data.jev.status}`
    throw new Error(
      `note evaluation revision obtained no class ranking; ${recorded}; run ${PLATFORM_SLUG} note evaluate --project ${input.project}`,
    )
  }
  return formatClassRanking(data)
}
