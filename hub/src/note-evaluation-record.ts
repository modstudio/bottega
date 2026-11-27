// concern: note evaluation record
/** Formats and reads the machine portion of a note evaluation document. */

import type { NoteClassPass } from './note-classification.ts'
import type { FailedCuratorPage, NoteCurationResult } from './note-curation.ts'
import type { NoteProposal, RankedClass } from './note-curation-decisions.ts'
import type { NoteEvaluationResult } from './note-evaluation.ts'
import { NOTE_EVALUATION_RECORD_SLUG } from './note-evaluation-identity.ts'

const DATA_FENCE = `${NOTE_EVALUATION_RECORD_SLUG}-json`
const DATA_BLOCK = new RegExp(`\n\`\`\`${DATA_FENCE}\n([\\s\\S]*?)\n\`\`\`(?:\n|$)`)

type NoteEvaluationBaseData = {
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

export function appendEvaluationRecordData(
  body: string,
  result: Pick<NoteEvaluationResult, 'clusters' | 'recall' | 'answerFailure'>,
): string {
  const data: NoteEvaluationBaseData = {
    clusters: result.clusters.map((cluster) => ({
      meanProbability: cluster.meanProbability,
      notes: cluster.notes.map(({ label, text }) => ({ label, text })),
    })),
    recall: result.recall,
    answerFailure: result.answerFailure,
  }
  return `${body}\n\n${dataFence(data)}`
}

function jevRecordLine(classPass: NoteClassPass): string {
  if (classPass.ran && classPass.answers > 0)
    return `Jev class pass ran: ${classPass.answers} answers.`
  if (classPass.ran) return 'Jev class pass ran and obtained no answers: 0 answers.'
  if (classPass.status.includes('skipped')) return 'Jev class pass skipped: 0 answers.'
  return 'Jev class pass obtained no answers: 0 answers.'
}

export function appendCurationRecord(
  body: string,
  classPass: NoteClassPass,
  curation: NoteCurationResult,
  proposals: NoteProposal[],
  ranking: RankedClass[],
): string {
  const base = recordData(body)
  if (!base || typeof base !== 'object')
    throw new Error('note evaluation record is missing its S1 data block')
  const data: NoteEvaluationRecordData = {
    ...(base as NoteEvaluationBaseData),
    jev: { ran: classPass.ran, status: classPass.status, answers: classPass.answers },
    proposals,
    failedPages: curation.failedPages,
    invalidEntries: curation.invalidEntries,
    stopped: curation.stopped,
    ranking,
  }
  const lines = [
    body.replace(DATA_BLOCK, ''),
    '',
    '## Class evaluation',
    '',
    jevRecordLine(classPass),
    `Curator proposals: ${curation.proposals.length}`,
    `Failed pages: ${curation.failedPages.length}`,
    `Invalid entries: ${curation.invalidEntries}`,
  ]
  if (curation.stopped) lines.push('Curation stopped: yes')
  lines.push('', '## Ranked classes', '')
  if (!ranking.length) lines.push('No class ranking was obtained.')
  let proposedIndex = 0
  for (const [index, item] of ranking.entries()) {
    const identity = item.proposed ? `proposed P${++proposedIndex}` : `${item.key}: ${item.name}`
    lines.push(
      `${index + 1}. ${identity} — ${item.noteCount} notes, ${item.sightings} sightings (${item.notes.join(', ')})`,
    )
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
  const recall = `${result.recall.produced}/${result.recall.total} (${
    result.recall.fraction === null ? 'n/a' : result.recall.fraction.toFixed(3)
  })`
  const lines = [
    `# Note evaluation: ${input.project}`,
    `Actionable notes: ${input.noteCount}`,
    `Candidate pairs: ${result.generatedPairs}`,
    `Pairs asked: ${result.pairsAsked}`,
    `Answers: ${result.answeredPairs} (${result.reusedAnswers} reused, ${result.newAnswers} new)`,
    `Blocking recall: ${recall}; ${result.recall.unreadable} unreadable positives excluded`,
  ]
  if (result.answerFailure) lines.push(`Duplicate answers: ${result.answerFailure}`)
  for (const [index, cluster] of result.clusters.entries()) {
    lines.push(`Cluster ${index + 1}: ${cluster.meanProbability.toFixed(3)}`)
    for (const note of cluster.notes) lines.push(`- ${note.label}: ${note.text}`)
  }
  if (input.classPass) lines.push(input.classPass.status)
  if (input.curation) {
    lines.push(
      `Curator proposals: ${input.curation.proposals.length}`,
      `Failed pages: ${input.curation.failedPages.length}`,
      `Invalid entries: ${input.curation.invalidEntries}`,
    )
    if (input.curation.stopped) lines.push(`Curation stopped: ${input.curation.stopped}`)
    for (const failure of input.curation.failedPages) {
      lines.push(
        `Failed page ${failure.page} (${failure.labels.join(', ')}), run ${failure.runId ?? 'none'}: ${failure.error}`,
      )
    }
  }
  for (const [index, item] of (input.ranking ?? []).entries()) {
    lines.push(
      `${index + 1}. ${item.proposed ? 'proposed ' : ''}${item.key}: ${item.name} — ${item.noteCount} notes, ${item.sightings} sightings (${item.notes.join(', ')})`,
    )
  }
  return lines.join('\n')
}

export function formatClassRanking(data: NoteEvaluationRecordData): string {
  return data.ranking
    .map(
      (item, index) =>
        `${index + 1}. ${item.proposed ? 'proposed ' : ''}${item.key}: ${item.name} — ${item.noteCount} notes, ${item.sightings} sightings\n   ${item.notes.join(', ')}`,
    )
    .join('\n')
}
