// concern: note evaluation
/** Generates and evaluates bounded note pairs, then clusters their answers. */

import type { Database } from 'bun:sqlite'
import { resolveActiveSpaceCredentialValue } from '../../shared/credential-value.ts'
import {
  resolveTypesafeCredential,
  TYPESAFE_CREDENTIAL_SET_COMMAND,
} from '../../shared/typed-question/client.ts'
import { typedQuestionStateIdentity } from '../../shared/typed-question/state-identity.ts'
import { db } from './db.ts'
import { duplicateScore } from './duplicate-score.ts'
import { NOTE_DUPLICATE_CANDIDATES } from './note-duplicate-candidates.ts'
import {
  NOTE_DUPLICATE_CONCURRENCY,
  NOTE_DUPLICATE_QUESTION,
  NOTE_PAIR_SUBJECT_KIND,
  noteDuplicateGoverningOutcome,
  notePairSubjectRef,
  noteTextHash,
  parseNotePairSubjectRef,
} from './note-duplicate-question.ts'
import { askHubTypedQuestion } from './typed-question-service.ts'

export type EvaluationNote = {
  record_id: string
  label: string
  project: string
  text: string
  created_at: string
}

export type EvaluationPair = {
  existing: EvaluationNote
  newer: EvaluationNote
  subjectRef: string
}

export type ScoredEvaluationPair = EvaluationPair & { probability: number; reused: boolean }

export type NoteEvaluationCluster = {
  notes: EvaluationNote[]
  meanProbability: number
}

export type NoteEvaluationResult = {
  generatedPairs: number
  pairsAsked: number
  answeredPairs: number
  reusedAnswers: number
  newAnswers: number
  answerFailure: string | null
  recall: { produced: number; total: number; fraction: number | null }
  clusters: NoteEvaluationCluster[]
}

type PairAnswerer = (
  pair: EvaluationPair,
) => Promise<{ probability: number; reused: boolean } | null>

type Dependencies = {
  credential(): Promise<{ available: true } | { available: false; reason: string }>
  answerPair: PairAnswerer
  positiveSubjects(
    notes: readonly EvaluationNote[],
    generated: ReadonlySet<string>,
  ): {
    produced: number
    total: number
  }
}

function filingOrder(
  left: EvaluationNote,
  right: EvaluationNote,
): [EvaluationNote, EvaluationNote] {
  return left.created_at.localeCompare(right.created_at) < 0 ||
    (left.created_at === right.created_at && left.record_id.localeCompare(right.record_id) < 0)
    ? [left, right]
    : [right, left]
}

export function generateEvaluationPairs(notes: readonly EvaluationNote[]): EvaluationPair[] {
  const pairs = new Map<string, EvaluationPair>()
  for (const note of notes) {
    const candidates = notes
      .filter((candidate) => candidate.record_id !== note.record_id)
      .map((candidate) => ({ candidate, score: duplicateScore(candidate.text, note.text) }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.candidate.record_id.localeCompare(right.candidate.record_id),
      )
      .slice(0, NOTE_DUPLICATE_CANDIDATES)
    for (const { candidate } of candidates) {
      const [existing, newer] = filingOrder(note, candidate)
      const pair = {
        existing,
        newer,
        subjectRef: notePairSubjectRef(existing.record_id, newer.text),
      }
      pairs.set(`${existing.record_id}:${newer.record_id}`, pair)
    }
  }
  return [...pairs.values()].sort(
    (left, right) =>
      left.existing.record_id.localeCompare(right.existing.record_id) ||
      left.newer.record_id.localeCompare(right.newer.record_id),
  )
}

function pairScore(
  left: readonly EvaluationNote[],
  right: readonly EvaluationNote[],
  scores: ReadonlyMap<string, number>,
): number {
  let total = 0
  for (const first of left) {
    for (const second of right) total += scores.get(pairKey(first, second)) ?? 0
  }
  return total / (left.length * right.length)
}

const pairKey = (left: EvaluationNote, right: EvaluationNote) =>
  left.record_id < right.record_id
    ? `${left.record_id}:${right.record_id}`
    : `${right.record_id}:${left.record_id}`

export function averageLinkageClusters(
  notes: readonly EvaluationNote[],
  pairs: readonly Pick<ScoredEvaluationPair, 'existing' | 'newer' | 'probability'>[],
  threshold = NOTE_DUPLICATE_QUESTION.threshold,
): NoteEvaluationCluster[] {
  const scores = new Map(
    pairs.map((pair) => [pairKey(pair.existing, pair.newer), pair.probability]),
  )
  const groups: EvaluationNote[][] = notes.map((note) => [note])
  for (;;) {
    let best: { left: number; right: number; score: number } | null = null
    for (let left = 0; left < groups.length; left++) {
      for (let right = left + 1; right < groups.length; right++) {
        const score = pairScore(groups[left]!, groups[right]!, scores)
        if (!best || score > best.score) best = { left, right, score }
      }
    }
    if (!best || best.score < threshold) break
    groups[best.left]!.push(...groups[best.right]!)
    groups.splice(best.right, 1)
  }
  return groups
    .filter((group) => group.length > 1)
    .map((group) => ({
      notes: group.sort((left, right) => left.label.localeCompare(right.label)),
      meanProbability: meanWithin(group, scores),
    }))
    .sort(
      (left, right) =>
        right.notes.length - left.notes.length ||
        right.meanProbability - left.meanProbability ||
        left.notes[0]!.label.localeCompare(right.notes[0]!.label),
    )
}

function meanWithin(notes: readonly EvaluationNote[], scores: ReadonlyMap<string, number>): number {
  let total = 0
  let count = 0
  for (let left = 0; left < notes.length; left++) {
    for (let right = left + 1; right < notes.length; right++) {
      total += scores.get(pairKey(notes[left]!, notes[right]!)) ?? 0
      count++
    }
  }
  return count ? total / count : 0
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor++
      results[index] = await operation(values[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
  return results
}

export async function evaluateNotePairs(
  notes: readonly EvaluationNote[],
  dependencies: Dependencies = defaultDependencies,
): Promise<NoteEvaluationResult> {
  const pairs = generateEvaluationPairs(notes)
  const generated = new Set(pairs.map((pair) => pair.subjectRef))
  const recall = dependencies.positiveSubjects(notes, generated)
  const credential = await dependencies.credential()
  if (!credential.available) {
    return {
      generatedPairs: pairs.length,
      pairsAsked: 0,
      answeredPairs: 0,
      reusedAnswers: 0,
      newAnswers: 0,
      answerFailure: credential.reason,
      recall: { ...recall, fraction: recall.total ? recall.produced / recall.total : null },
      clusters: [],
    }
  }
  const answered = await mapConcurrent(pairs, NOTE_DUPLICATE_CONCURRENCY, dependencies.answerPair)
  const scored = pairs.flatMap((pair, index) => {
    const answer = answered[index]
    return answer ? [{ ...pair, ...answer }] : []
  })
  return {
    generatedPairs: pairs.length,
    pairsAsked: pairs.length,
    answeredPairs: scored.length,
    reusedAnswers: scored.filter((pair) => pair.reused).length,
    newAnswers: scored.filter((pair) => !pair.reused).length,
    answerFailure: scored.length
      ? null
      : 'no answers obtained: the typed-question service returned no answers',
    recall: { ...recall, fraction: recall.total ? recall.produced / recall.total : null },
    clusters: averageLinkageClusters(notes, scored),
  }
}

async function credentialAvailability() {
  try {
    const credential = await resolveTypesafeCredential(resolveActiveSpaceCredentialValue)
    return credential.kind === 'resolved'
      ? ({ available: true } as const)
      : ({
          available: false,
          reason: `no answers obtained: the typesafe/api-key credential is not configured; run ${TYPESAFE_CREDENTIAL_SET_COMMAND}`,
        } as const)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { available: false, reason: `no answers obtained: ${message}` } as const
  }
}

function priorProbability(database: Database, pair: EvaluationPair): number | null {
  const state = { existing: pair.existing.text, new: pair.newer.text }
  const row = database
    .query<{ answer_json: string }, [string, number, string, string]>(
      `SELECT answer_json FROM typed_question_answer
       WHERE question_id=? AND question_version=? AND subject_ref=? AND state_sha=?
         AND answer_json IS NOT NULL AND error IS NULL ORDER BY created_at DESC LIMIT 1`,
    )
    .get(
      NOTE_DUPLICATE_QUESTION.id,
      NOTE_DUPLICATE_QUESTION.version,
      pair.subjectRef,
      typedQuestionStateIdentity(state),
    )
  if (!row) return null
  try {
    const answer = JSON.parse(row.answer_json) as { noul?: unknown }
    return typeof answer.noul === 'number' ? answer.noul : null
  } catch {
    return null
  }
}

export async function answerEvaluationPair(
  pair: EvaluationPair,
  database: Database = db(),
  ask = askHubTypedQuestion,
) {
  const prior = priorProbability(database, pair)
  if (prior !== null) return { probability: prior, reused: true }
  const answer = await ask({
    question: NOTE_DUPLICATE_QUESTION,
    subjectKind: NOTE_PAIR_SUBJECT_KIND,
    subjectRef: pair.subjectRef,
    state: { existing: pair.existing.text, new: pair.newer.text },
  })
  return answer && 'noul' in answer ? { probability: answer.noul, reused: false } : null
}

export function blockingRecall(
  database: Database,
  notes: readonly EvaluationNote[],
  generated: ReadonlySet<string>,
): { produced: number; total: number } {
  const byId = new Map(notes.map((note) => [note.record_id, note]))
  const subjects = database
    .query<{ subject_ref: string }, [string, number]>(
      `SELECT DISTINCT subject_ref FROM typed_question_outcome
       WHERE question_id=? AND question_version=?`,
    )
    .all(NOTE_DUPLICATE_QUESTION.id, NOTE_DUPLICATE_QUESTION.version)
  let produced = 0
  let total = 0
  for (const { subject_ref } of subjects) {
    const outcome = noteDuplicateGoverningOutcome(database, subject_ref)
    if (!outcome || !['merge', 'same-as'].includes(outcome.source)) continue
    const parsed = parseNotePairSubjectRef(subject_ref)
    const existing = parsed ? byId.get(parsed.existingId) : undefined
    const newer = parsed
      ? notes.find(
          (note) => note.record_id !== parsed.existingId && noteTextHash(note.text) === parsed.hash,
        )
      : undefined
    if (!existing || !newer) continue
    total++
    if (generated.has(subject_ref)) produced++
  }
  return { produced, total }
}

const defaultDependencies: Dependencies = {
  credential: credentialAvailability,
  answerPair: (pair) => answerEvaluationPair(pair),
  positiveSubjects: (notes, generated) => blockingRecall(db(), notes, generated),
}

export function noteEvaluationBody(
  project: string,
  at: string,
  noteCount: number,
  result: NoteEvaluationResult,
): string {
  const recall = `${result.recall.produced}/${result.recall.total} (${
    result.recall.fraction === null ? 'n/a' : result.recall.fraction.toFixed(3)
  })`
  const lines = [
    `# Note evaluation: ${project}`,
    '',
    `Run time: ${at}`,
    `Actionable notes: ${noteCount}`,
    `Candidate pairs: ${result.generatedPairs}`,
    `Pairs asked: ${result.pairsAsked}`,
    `Answers: ${result.answeredPairs} (${result.reusedAnswers} reused, ${result.newAnswers} new)`,
    `Blocking recall: ${recall}`,
  ]
  if (result.answerFailure) lines.push('', result.answerFailure)
  lines.push('', '## Duplicate clusters')
  if (!result.clusters.length) lines.push('', 'No scored clusters were obtained.')
  for (const [index, cluster] of result.clusters.entries()) {
    lines.push(
      '',
      `### ${index + 1}. ${cluster.notes.length} notes, mean ${cluster.meanProbability.toFixed(3)}`,
    )
    for (const note of cluster.notes) lines.push('', `- ${note.label}: ${note.text}`)
  }
  return lines.join('\n')
}
