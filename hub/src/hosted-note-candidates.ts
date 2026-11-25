// concern: hosted-note-candidates
/** Reads the bounded duplicate-candidate projection under the caller's hosted tenancy. */

import type { SQL } from 'bun'
import { formatNoteLabel } from '../../shared/note-label.ts'
import {
  noteDuplicateQuestionCandidates,
  type RankedDuplicateQuestionNote,
} from './note-duplicate-candidates.ts'
import { type TaskIdentity, withHostedTenant } from './hosted-tenant.ts'

export type HostedNoteCandidate = {
  record_id: string
  number: number
  label: string
  project: string
  text: string
  stale_at: string | null
}

type CandidateRow = Omit<HostedNoteCandidate, 'label'>

export async function listHostedNoteCandidates(
  url: SQL,
  identity: TaskIdentity,
  project: string,
  text: string,
): Promise<HostedNoteCandidate[]> {
  return withHostedTenant(url, identity, async (tx) => {
    const rows = (await tx<CandidateRow[]>`
      SELECT id::text record_id,number::int number,project,text,stale_at
      FROM hub_note
      WHERE space_id=${identity.spaceId}::uuid AND project=${project}
        AND stale_at IS NULL AND promoted_task IS NULL AND deleted_at IS NULL
    `) as CandidateRow[]
    return noteDuplicateQuestionCandidates(rows, project, text).map(
      ({ score: _score, ...row }: RankedDuplicateQuestionNote<CandidateRow>) => ({
        ...row,
        label: formatNoteLabel(row.project, row.number),
      }),
    )
  })
}
