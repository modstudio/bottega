// concern: finding-duplicate-suggestions
/** Selects, asks, and presents duplicate-finding candidates without blocking collection. */

import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { JOBS } from '../jobs/jobs.ts'
import { FINDING_DUPLICATE_QUESTION } from '../typed-question/finding-duplicate-question.ts'
import { askTypedQuestion } from '../typed-question/typed-question-service.ts'

const FINDING_DUPLICATE_ASK_CONCURRENCY = 8
const FINDING_DUPLICATE_PAIR_CAP = 200

export type DuplicateFindingRow = {
  findingRecordId: string
  runRecordId: string
  runNumber: number
  job: string
  reviewRecordId: string
  reviewedTip: string | null
  ordinal: number
  location: string
  severity: string
  evidence: string
  proposedCorrection: string
}

type FindingState = {
  location: string
  severity: string
  evidence: string
  proposed_correction: string
}

export type FindingDuplicatePair = {
  subjectRef: string
  state: { findings: [FindingState, FindingState] }
  stateSha: string
  current: DuplicateFindingRow
  other: DuplicateFindingRow
  recordedAnswerJson: string | null | undefined
}

function findingState(row: DuplicateFindingRow): FindingState {
  return {
    location: row.location,
    severity: row.severity,
    evidence: row.evidence,
    proposed_correction: row.proposedCorrection,
  }
}

function identity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function pairFor(
  current: DuplicateFindingRow,
  other: DuplicateFindingRow,
  recorded: ReadonlyMap<string, string | null>,
): FindingDuplicatePair {
  const sorted = [current, other].sort((a, b) =>
    a.findingRecordId.localeCompare(b.findingRecordId),
  ) as [DuplicateFindingRow, DuplicateFindingRow]
  const subjectRef = sorted.map((row) => row.findingRecordId).join(':')
  const state = { findings: sorted.map(findingState) as [FindingState, FindingState] }
  const stateSha = identity(state)
  return {
    subjectRef,
    state,
    stateSha,
    current,
    other,
    recordedAnswerJson: recorded.get(`${subjectRef}\0${stateSha}`),
  }
}

/** Pure cross-lens selection using the same-review-or-tip eligibility rule. */
export function selectFindingDuplicatePairs(
  currentRunRecordId: string,
  rows: readonly DuplicateFindingRow[],
  recorded: ReadonlyMap<string, string | null>,
): FindingDuplicatePair[] {
  const current = rows.filter((row) => row.runRecordId === currentRunRecordId)
  if (!current.length) return []
  const reviewIds = new Set(current.map((row) => row.reviewRecordId))
  const tips = new Set(current.flatMap((row) => (row.reviewedTip ? [row.reviewedTip] : [])))
  const others = rows.filter(
    (row) =>
      row.runRecordId !== currentRunRecordId &&
      Boolean(JOBS[row.job]?.findings) &&
      (reviewIds.has(row.reviewRecordId) ||
        (row.reviewedTip !== null && tips.has(row.reviewedTip))),
  )
  return current
    .flatMap((finding) => others.map((other) => pairFor(finding, other, recorded)))
    .sort(
      (a, b) =>
        a.current.ordinal - b.current.ordinal ||
        a.other.runNumber - b.other.runNumber ||
        a.other.ordinal - b.other.ordinal,
    )
}

function probability(answerJson: string | null | undefined): number | null | undefined {
  if (answerJson === undefined) return undefined
  if (answerJson === null) return null
  try {
    const value = JSON.parse(answerJson) as { noul?: unknown }
    return typeof value.noul === 'number' ? value.noul : null
  } catch {
    return null
  }
}

/** Exact score flag for a suggestion oriented to the run being collected. */
export function duplicateSuggestionLine(pair: FindingDuplicatePair, noul: number): string {
  return (
    `likely duplicate ${noul.toFixed(2)}: ${pair.current.runNumber}#${pair.current.ordinal} and ` +
    `${pair.other.runNumber}#${pair.other.ordinal} — ` +
    `--duplicate ${pair.current.ordinal}=${pair.other.runNumber}#${pair.other.ordinal}`
  )
}

/** Pairs whose exact subject and state have no recorded answer yet. */
export function unansweredFindingDuplicatePairs(
  pairs: readonly FindingDuplicatePair[],
): FindingDuplicatePair[] {
  return pairs.filter((pair) => pair.recordedAnswerJson === undefined)
}

type SuggestionResult = { lines: string[]; skipped: number }

async function askUnrecorded(pairs: FindingDuplicatePair[]): Promise<number[] | null> {
  const values = new Array<number>(pairs.length)
  let next = 0
  let failed = false
  await Promise.all(
    Array.from({ length: Math.min(FINDING_DUPLICATE_ASK_CONCURRENCY, pairs.length) }, async () => {
      for (;;) {
        const index = next++
        if (index >= pairs.length) return
        const pair = pairs[index]!
        const answer = await askTypedQuestion({
          question: FINDING_DUPLICATE_QUESTION,
          subjectKind: 'finding-pair',
          subjectRef: pair.subjectRef,
          state: pair.state,
        })
        if (!answer || !('noul' in answer)) failed = true
        else values[index] = answer.noul
      }
    }),
  )
  return failed ? null : values
}

function findingRows(database: Database, runRecordId: string): DuplicateFindingRow[] {
  const current = database
    .query<{ head_commit: string | null }, [string]>(
      'SELECT head_commit FROM run WHERE record_id=?',
    )
    .get(runRecordId)
  if (!current) return []
  return database
    .query(
      `SELECT finding.record_id AS findingRecordId,lens.run_record_id AS runRecordId,
              run.number AS runNumber,run.job, finding.review_record_id AS reviewRecordId,
              run.head_commit AS reviewedTip,finding.ordinal,finding.location,finding.severity,
              finding.evidence,finding.proposed_correction AS proposedCorrection
         FROM review_finding finding
         JOIN review_lens lens ON lens.record_id=finding.review_lens_record_id
         JOIN run ON run.record_id=lens.run_record_id
        WHERE finding.review_record_id IN (
          SELECT review_record_id FROM review_lens WHERE run_record_id=?
        ) OR (run.head_commit IS NOT NULL AND run.head_commit=?)
        ORDER BY run.number,finding.ordinal`,
    )
    .all(runRecordId, current.head_commit) as DuplicateFindingRow[]
}

/** Answers only: an error row is not an answer, so its pair is asked again. */
export function recordedAnswers(database: Database): Map<string, string | null> {
  const rows = database
    .query(
      `SELECT subject_ref,state_sha,answer_json FROM typed_question_answer
        WHERE question_id=? AND question_version=? AND error IS NULL AND answer_json IS NOT NULL
        ORDER BY created_at`,
    )
    .all(FINDING_DUPLICATE_QUESTION.id, FINDING_DUPLICATE_QUESTION.version) as {
    subject_ref: string
    state_sha: string
    answer_json: string | null
  }[]
  return new Map(rows.map((row) => [`${row.subject_ref}\0${row.state_sha}`, row.answer_json]))
}

/** Fail-open result enrichment. Any unavailable answer suppresses all extra presentation. */
export async function findingDuplicateSuggestions(
  database: Database,
  runRecordId: string,
): Promise<SuggestionResult> {
  try {
    const selected = selectFindingDuplicatePairs(
      runRecordId,
      findingRows(database, runRecordId),
      recordedAnswers(database),
    )
    const pairs = selected.slice(0, FINDING_DUPLICATE_PAIR_CAP)
    const unrecorded = unansweredFindingDuplicatePairs(pairs)
    const asked = await askUnrecorded(unrecorded)
    if (asked === null) return { lines: [], skipped: 0 }
    const askedBySubject = new Map(
      unrecorded.map((pair, index) => [`${pair.subjectRef}\0${pair.stateSha}`, asked[index]!]),
    )
    const scored = pairs.map((pair) => {
      const recorded = probability(pair.recordedAnswerJson)
      return recorded === undefined
        ? askedBySubject.get(`${pair.subjectRef}\0${pair.stateSha}`)
        : recorded
    })
    if (scored.some((value) => value === null || value === undefined)) {
      return { lines: [], skipped: 0 }
    }
    return {
      lines: pairs.flatMap((pair, index) =>
        scored[index]! >= FINDING_DUPLICATE_QUESTION.threshold
          ? [duplicateSuggestionLine(pair, scored[index]!)]
          : [],
      ),
      skipped: Math.max(0, selected.length - pairs.length),
    }
  } catch {
    return { lines: [], skipped: 0 }
  }
}
