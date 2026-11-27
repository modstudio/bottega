// concern: note evaluation record
/** Formats and reads the machine portion of a note evaluation document. */

import type { NoteClassPass } from './note-classification.ts'
import type { FailedCuratorPage, NoteCurationResult } from './note-curation.ts'
import type { NoteProposal, RankedClass } from './note-curation-decisions.ts'
import {
  type NoteEvaluationResult,
  type NoteEvaluationSurface,
  noteEvaluationHeaderLines,
} from './note-evaluation.ts'
import { NOTE_EVALUATION_RECORD_SLUG } from './note-evaluation-identity.ts'

const DATA_FENCE = `${NOTE_EVALUATION_RECORD_SLUG}-json`
const DATA_BLOCK = new RegExp(`\n\`\`\`${DATA_FENCE}\n([\\s\\S]*?)\n\`\`\`(?:\n|$)`)

export type NoteEvaluationBaseData = {
  clusters: Array<{
    meanProbability: number
    notes: Array<{ label: string; text: string }>
  }>
  recall: NoteEvaluationResult['recall']
  answerFailure: string | null
}

export type NoteEvaluationRecordData = NoteEvaluationBaseData & {
  jev: Pick<NoteClassPass, 'ran' | 'status' | 'answers'>
  proposals: NoteProposal[]
  failedPages: FailedCuratorPage[]
  invalidEntries: number
  stopped: string | null
  ranking: RankedClass[]
}

type SummaryInput = {
  project: string
  noteCount: number
  at: string
  result: NoteEvaluationResult
  classPass?: NoteClassPass
  curation?: NoteCurationResult
  ranking?: RankedClass[]
}

/** Keeps foreign strings round-trippable while making them inert to stored-document lint. */
export function serializeNoteEvaluationRecordData(data: unknown): string {
  return JSON.stringify(data, null, 2)
    .replaceAll('`', '\\u0060')
    .replace(/\b(bun|npm) run/g, '$1\\u0020run')
}

function dataFence(data: unknown): string {
  return `\`\`\`${DATA_FENCE}\n${serializeNoteEvaluationRecordData(data)}\n\`\`\``
}

function recordData(body: string): unknown {
  const match = DATA_BLOCK.exec(body)
  if (!match) return null
  try {
    return JSON.parse(match[1]!)
  } catch {
    return null
  }
}

export function appendEvaluationRecordData(body: string, data: NoteEvaluationBaseData): string {
  return `${body}\n\n${dataFence(data)}`
}

export function noteEvaluationBaseData(
  result: Pick<NoteEvaluationResult, 'clusters' | 'recall' | 'answerFailure'>,
): NoteEvaluationBaseData {
  return {
    clusters: result.clusters.map((cluster) => ({
      meanProbability: cluster.meanProbability,
      notes: cluster.notes.map(({ label, text }) => ({ label, text })),
    })),
    recall: result.recall,
    answerFailure: result.answerFailure,
  }
}

function jevRecordLine(classPass: NoteClassPass): string {
  if (classPass.ran && classPass.answers > 0)
    return `Jev class pass ran: ${classPass.answers} answers.`
  if (classPass.ran) return 'Jev class pass ran and obtained no answers: 0 answers.'
  if (classPass.status.includes('skipped')) return 'Jev class pass skipped: 0 answers.'
  return 'Jev class pass obtained no answers: 0 answers.'
}

function classEvaluationLines(
  classPass: NoteClassPass,
  curation: NoteCurationResult,
  surface: NoteEvaluationSurface,
): string[] {
  const lines = [
    surface === 'record' ? jevRecordLine(classPass) : classPass.status,
    `Curator proposals: ${curation.proposals.length}`,
    `Failed pages: ${curation.failedPages.length}`,
    `Invalid entries: ${curation.invalidEntries}`,
  ]
  if (curation.stopped) {
    lines.push(
      surface === 'record' ? 'Curation stopped: yes' : `Curation stopped: ${curation.stopped}`,
    )
  }
  if (surface === 'stdout') {
    for (const failure of curation.failedPages) {
      lines.push(
        `Failed page ${failure.page} (${failure.labels.join(', ')}), run ${failure.runId ?? 'none'}: ${failure.error}`,
      )
    }
  }
  return lines
}

function rankedClassLine(
  item: RankedClass,
  index: number,
  proposedIndex: number,
  surface: NoteEvaluationSurface,
): string {
  const identity = item.proposed
    ? surface === 'record'
      ? `proposed P${proposedIndex}`
      : `proposed P${proposedIndex} ${item.key}: ${item.name}`
    : surface === 'record'
      ? item.key
      : `${item.key}: ${item.name}`
  return `${index + 1}. ${identity} — ${item.noteCount} notes, ${item.sightings} sightings (${item.notes.join(', ')})`
}

export function appendCurationRecord(
  body: string,
  base: NoteEvaluationBaseData,
  classPass: NoteClassPass,
  curation: NoteCurationResult,
  proposals: NoteProposal[],
  ranking: RankedClass[],
): string {
  const data: NoteEvaluationRecordData = {
    ...base,
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
    ...classEvaluationLines(classPass, curation, 'record'),
  ]
  lines.push('', '## Ranked classes', '')
  if (!ranking.length) lines.push('No class ranking was obtained.')
  let proposedIndex = 0
  for (const [index, item] of ranking.entries()) {
    if (item.proposed) proposedIndex++
    lines.push(rankedClassLine(item, index, proposedIndex, 'record'))
  }
  lines.push('', dataFence(data))
  return lines.join('\n')
}

export function parseCurationRecord(body: string): NoteEvaluationRecordData | null {
  const data = recordData(body) as Partial<NoteEvaluationRecordData> | null
  return data && Array.isArray(data.ranking) && data.jev ? (data as NoteEvaluationRecordData) : null
}

export function formatNoteEvaluationSummary(input: SummaryInput): string {
  const { result } = input
  const lines = noteEvaluationHeaderLines(input.project, input.noteCount, result, 'stdout')
  lines.splice(1, 0, `Run time: ${input.at}`)
  for (const [index, cluster] of result.clusters.entries()) {
    lines.push(`Cluster ${index + 1}: ${cluster.meanProbability.toFixed(3)}`)
    for (const note of cluster.notes) lines.push(`- ${note.label}: ${note.text}`)
  }
  if (input.classPass && input.curation)
    lines.push(...classEvaluationLines(input.classPass, input.curation, 'stdout'))
  let proposedIndex = 0
  for (const [index, item] of (input.ranking ?? []).entries()) {
    if (item.proposed) proposedIndex++
    lines.push(rankedClassLine(item, index, proposedIndex, 'stdout'))
  }
  return lines.join('\n')
}

export function formatClassRanking(data: NoteEvaluationRecordData): string {
  let proposedIndex = 0
  return data.ranking
    .map((item, index) => {
      if (item.proposed) proposedIndex++
      return rankedClassLine(item, index, proposedIndex, 'stdout')
    })
    .join('\n')
}
