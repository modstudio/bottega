// concern: note evaluation
/** Generates and evaluates bounded note pairs, then clusters their answers. */

import type { Database } from 'bun:sqlite'
import { resolveActiveSpaceCredentialValue } from '../../shared/credential-value.ts'
import {
  resolveTypesafeCredential,
  TYPESAFE_CREDENTIAL_SET_COMMAND,
} from '../../shared/typed-question/client.ts'
import { db } from './db.ts'
import { duplicateTokenSet } from './duplicate-score.ts'
import { rankDuplicateCandidates } from './note-duplicate-candidates.ts'
import { readNoteDuplicateSubjects } from './note-duplicate-pair-state.ts'
import {
  compareNoteFilingOrder,
  NOTE_DUPLICATE_CONCURRENCY,
  NOTE_DUPLICATE_QUESTION,
  NOTE_PAIR_SUBJECT_KIND,
  notePairSubjectRef,
  noteTextHash,
} from './note-duplicate-question.ts'
import { askHubTypedQuestionWithReuse } from './typed-question-service.ts'

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
  recall: { produced: number; total: number; unreadable: number; fraction: number | null }
  clusters: NoteEvaluationCluster[]
}

type PairAnswerer = (
  pair: EvaluationPair,
) => Promise<{ probability: number; reused: boolean } | null>

type Dependencies = {
  credential(): Promise<{ available: true } | { available: false; reason: string }>
  answerPair: PairAnswerer
  positiveSubjects(
    project: string,
    actionableNotes: readonly EvaluationNote[],
    allProjectNotes: readonly EvaluationNote[],
  ): {
    produced: number
    total: number
    unreadable: number
  }
}

export function generateEvaluationPairs(notes: readonly EvaluationNote[]): EvaluationPair[] {
  const pairs = new Map<string, EvaluationPair>()
  const tokens = new Map(notes.map((note) => [note.record_id, duplicateTokenSet(note.text)]))
  for (const note of notes) {
    const candidates = rankDuplicateCandidates(
      notes
        .filter((candidate) => candidate.record_id !== note.record_id)
        .map((candidate) => ({ ...candidate, tokens: tokens.get(candidate.record_id)! })),
      tokens.get(note.record_id)!,
    )
    for (const candidate of candidates) {
      const noteIsExisting = compareNoteFilingOrder(note, candidate) <= 0
      const existing: EvaluationNote = noteIsExisting ? note : candidate
      const newer: EvaluationNote = noteIsExisting ? candidate : note
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

type SparseGroup = {
  id: number
  order: number
  notes: EvaluationNote[]
  size: number
  internalSum: number
  neighbours: Map<number, number>
}

type LinkCandidate = {
  left: number
  right: number
  leftOrder: number
  rightOrder: number
  score: number
}

const candidateHigherPriority = (left: LinkCandidate, right: LinkCandidate) =>
  left.score > right.score ||
  (left.score === right.score &&
    (left.leftOrder < right.leftOrder ||
      (left.leftOrder === right.leftOrder && left.rightOrder < right.rightOrder)))

class CandidateHeap {
  readonly values: LinkCandidate[] = []

  push(candidate: LinkCandidate): void {
    this.values.push(candidate)
    let index = this.values.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (candidateHigherPriority(this.values[parent]!, candidate)) break
      this.values[index] = this.values[parent]!
      index = parent
    }
    this.values[index] = candidate
  }

  pop(): LinkCandidate | undefined {
    const first = this.values[0]
    const last = this.values.pop()
    if (!first || !last || !this.values.length) return first
    let index = 0
    while (index * 2 + 1 < this.values.length) {
      let child = index * 2 + 1
      if (
        child + 1 < this.values.length &&
        candidateHigherPriority(this.values[child + 1]!, this.values[child]!)
      )
        child++
      if (candidateHigherPriority(last, this.values[child]!)) break
      this.values[index] = this.values[child]!
      index = child
    }
    this.values[index] = last
    return first
  }
}

function pushGroupCandidate(
  heap: CandidateHeap,
  first: SparseGroup,
  second: SparseGroup,
  sum: number,
): void {
  const [left, right] = first.order < second.order ? [first, second] : [second, first]
  heap.push({
    left: left.id,
    right: right.id,
    leftOrder: left.order,
    rightOrder: right.order,
    score: sum / (left.size * right.size),
  })
}

function sparseGroups(
  notes: readonly EvaluationNote[],
  pairs: readonly Pick<ScoredEvaluationPair, 'existing' | 'newer' | 'probability'>[],
): Map<number, SparseGroup> {
  const groups = new Map<number, SparseGroup>(
    notes.map((note, index) => [
      index,
      { id: index, order: index, notes: [note], size: 1, internalSum: 0, neighbours: new Map() },
    ]),
  )
  const noteGroup = new Map(notes.map((note, index) => [note.record_id, index]))
  for (const pair of pairs) {
    if (pair.probability === 0) continue
    const left = noteGroup.get(pair.existing.record_id)
    const right = noteGroup.get(pair.newer.record_id)
    if (left === undefined || right === undefined || left === right) continue
    groups
      .get(left)!
      .neighbours.set(right, (groups.get(left)!.neighbours.get(right) ?? 0) + pair.probability)
    groups
      .get(right)!
      .neighbours.set(left, (groups.get(right)!.neighbours.get(left) ?? 0) + pair.probability)
  }
  return groups
}

function candidateHeap(groups: ReadonlyMap<number, SparseGroup>): CandidateHeap {
  const heap = new CandidateHeap()
  for (const group of groups.values()) {
    for (const [otherId, sum] of group.neighbours) {
      const other = groups.get(otherId)!
      if (group.order < other.order) pushGroupCandidate(heap, group, other, sum)
    }
  }
  return heap
}

function mergeSparseGroups(
  groups: Map<number, SparseGroup>,
  heap: CandidateHeap,
  left: SparseGroup,
  right: SparseGroup,
  sum: number,
): void {
  left.notes.push(...right.notes)
  left.internalSum += right.internalSum + sum
  left.size += right.size
  left.neighbours.delete(right.id)
  for (const [neighbourId, rightSum] of right.neighbours) {
    if (neighbourId === left.id) continue
    const neighbour = groups.get(neighbourId)
    if (!neighbour) continue
    const combined = (left.neighbours.get(neighbourId) ?? 0) + rightSum
    left.neighbours.set(neighbourId, combined)
    neighbour.neighbours.delete(right.id)
    neighbour.neighbours.set(left.id, combined)
    pushGroupCandidate(heap, left, neighbour, combined)
  }
  groups.delete(right.id)
}

function joinSparseGroups(
  groups: Map<number, SparseGroup>,
  heap: CandidateHeap,
  threshold: number,
): void {
  for (;;) {
    const best = heap.pop()
    if (!best) return
    const left = groups.get(best.left)
    const right = groups.get(best.right)
    if (!left || !right) continue
    const sum = left.neighbours.get(right.id)
    if (sum === undefined || sum / (left.size * right.size) !== best.score) continue
    if (best.score < threshold) return
    mergeSparseGroups(groups, heap, left, right, sum)
  }
}

export function averageLinkageClusters(
  notes: readonly EvaluationNote[],
  pairs: readonly Pick<ScoredEvaluationPair, 'existing' | 'newer' | 'probability'>[],
  threshold = NOTE_DUPLICATE_QUESTION.threshold,
): NoteEvaluationCluster[] {
  const groups = sparseGroups(notes, pairs)
  joinSparseGroups(groups, candidateHeap(groups), threshold)
  return [...groups.values()]
    .filter((group) => group.size > 1)
    .map((group) => ({
      notes: group.notes.sort((left, right) => left.label.localeCompare(right.label)),
      meanProbability: group.internalSum / ((group.size * (group.size - 1)) / 2),
    }))
    .sort(
      (left, right) =>
        right.notes.length - left.notes.length ||
        right.meanProbability - left.meanProbability ||
        left.notes[0]!.label.localeCompare(right.notes[0]!.label),
    )
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
  project: string,
  actionableNotes: readonly EvaluationNote[],
  allProjectNotes: readonly EvaluationNote[],
  dependencies: Dependencies = defaultDependencies,
): Promise<NoteEvaluationResult> {
  const pairs = generateEvaluationPairs(actionableNotes)
  const recall = dependencies.positiveSubjects(project, actionableNotes, allProjectNotes)
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
    pairsAsked: answered.filter((answer) => answer === null || !answer.reused).length,
    answeredPairs: scored.length,
    reusedAnswers: scored.filter((pair) => pair.reused).length,
    newAnswers: scored.filter((pair) => !pair.reused).length,
    answerFailure:
      pairs.length > 0 && scored.length === 0
        ? 'no answers obtained: the typed-question service returned no answers'
        : null,
    recall: { ...recall, fraction: recall.total ? recall.produced / recall.total : null },
    clusters: averageLinkageClusters(actionableNotes, scored),
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

export async function answerEvaluationPair(
  pair: EvaluationPair,
  ask = askHubTypedQuestionWithReuse,
) {
  const result = await ask({
    question: NOTE_DUPLICATE_QUESTION,
    subjectKind: NOTE_PAIR_SUBJECT_KIND,
    subjectRef: pair.subjectRef,
    state: { existing: pair.existing.text, new: pair.newer.text },
  })
  return result && 'noul' in result.answer
    ? { probability: result.answer.noul, reused: result.reused }
    : null
}

export function blockingRecall(
  database: Database,
  project: string,
  actionableNotes: readonly EvaluationNote[],
  allProjectNotes: readonly EvaluationNote[],
): { produced: number; total: number; unreadable: number } {
  const noteLookup = new Map(
    allProjectNotes.map((note) => [note.record_id, { project: note.project, text: note.text }]),
  )
  const subjects = readNoteDuplicateSubjects(database, noteLookup, { project })
  const positives = subjects.readable.filter((subject) => subject.label)
  const unreadable = subjects.unreadable.filter((subject) => subject.label).length
  const actionableEntries = actionableNotes.map((note) => ({
    record_id: note.record_id,
    hash: noteTextHash(note.text),
    tokens: duplicateTokenSet(note.text),
  }))
  let produced = 0
  for (const subject of positives) {
    const existing = {
      record_id: subject.existingId,
      tokens: duplicateTokenSet(subject.state.existing),
    }
    const newer = {
      record_id: `new:${subject.subjectRef}`,
      tokens: duplicateTokenSet(subject.state.new),
    }
    const pool = actionableEntries
      .filter((note) => note.record_id !== subject.existingId && note.hash !== subject.hash)
      .map(({ record_id, tokens }) => ({ record_id, tokens }))
      .concat(existing, newer)
    if (isTopCandidate(existing, newer, pool) || isTopCandidate(newer, existing, pool)) produced++
  }
  return {
    produced,
    total: positives.length,
    unreadable,
  }
}

function isTopCandidate(
  note: { record_id: string; tokens: ReadonlySet<string> },
  candidate: { record_id: string },
  pool: readonly { record_id: string; tokens: ReadonlySet<string> }[],
): boolean {
  return rankDuplicateCandidates(
    pool.filter((other) => other.record_id !== note.record_id),
    note.tokens,
  ).some(({ record_id }) => record_id === candidate.record_id)
}

const defaultDependencies: Dependencies = {
  credential: credentialAvailability,
  answerPair: (pair) => answerEvaluationPair(pair),
  positiveSubjects: (project, actionableNotes, allProjectNotes) =>
    blockingRecall(db(), project, actionableNotes, allProjectNotes),
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
    `Blocking recall: ${recall}; ${result.recall.unreadable} unreadable positives excluded`,
  ]
  if (!result.generatedPairs) lines.push('', 'No candidate pairs to ask.')
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
