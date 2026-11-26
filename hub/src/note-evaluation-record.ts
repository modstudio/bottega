// concern: note evaluation record
/** Formats and reads the machine portion of a note evaluation document. */

import type { NoteClassPass } from './note-classification.ts'
import type { FailedCuratorPage, NoteCurationResult } from './note-curation.ts'
import type { NoteProposal, RankedClass } from './note-curation-decisions.ts'
import { NOTE_EVALUATION_RECORD_SLUG } from './note-evaluation-identity.ts'

const DATA_FENCE = `${NOTE_EVALUATION_RECORD_SLUG}-json`

export type NoteEvaluationRecordData = {
  jev: Pick<NoteClassPass, 'ran' | 'status' | 'answers'>
  proposals: NoteProposal[]
  failedPages: FailedCuratorPage[]
  invalidEntries: number
  stopped: string | null
  ranking: RankedClass[]
}

export function appendCurationRecord(
  body: string,
  classPass: NoteClassPass,
  curation: NoteCurationResult,
  proposals: NoteProposal[],
  ranking: RankedClass[],
): string {
  const data: NoteEvaluationRecordData = {
    jev: { ran: classPass.ran, status: classPass.status, answers: classPass.answers },
    proposals,
    failedPages: curation.failedPages,
    invalidEntries: curation.invalidEntries,
    stopped: curation.stopped,
    ranking,
  }
  const lines = [
    body,
    '',
    '## Class evaluation',
    '',
    classPass.status,
    `Curator proposals: ${curation.proposals.length}`,
    `Failed pages: ${curation.failedPages.length}`,
    `Invalid entries: ${curation.invalidEntries}`,
  ]
  if (curation.stopped) lines.push(`Curation stopped: ${curation.stopped}`)
  lines.push('', '## Ranked classes', '')
  if (!ranking.length) lines.push('No class ranking was obtained.')
  for (const [index, item] of ranking.entries()) {
    lines.push(
      `${index + 1}. ${item.proposed ? 'proposed ' : ''}${item.key}: ${item.name} — ${item.noteCount} notes, ${item.sightings} sightings (${item.notes.join(', ')})`,
    )
  }
  lines.push('', `\`\`\`${DATA_FENCE}`, JSON.stringify(data, null, 2), '```')
  return lines.join('\n')
}

export function parseCurationRecord(body: string): NoteEvaluationRecordData | null {
  const match = new RegExp(
    `\\n\\\`\\\`\\\`${DATA_FENCE}\\n([\\s\\S]*?)\\n\\\`\\\`\\\`(?:\\n|$)`,
  ).exec(body)
  if (!match) return null
  try {
    const data = JSON.parse(match[1]!) as NoteEvaluationRecordData
    return Array.isArray(data.ranking) ? data : null
  } catch {
    return null
  }
}

export function formatClassRanking(data: NoteEvaluationRecordData): string {
  return data.ranking
    .map(
      (item, index) =>
        `${index + 1}. ${item.proposed ? 'proposed ' : ''}${item.key}: ${item.name} — ${item.noteCount} notes, ${item.sightings} sightings\n   ${item.notes.join(', ')}`,
    )
    .join('\n')
}
