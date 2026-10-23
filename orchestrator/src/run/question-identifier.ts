// concern: run-control
/** Resolves a user-facing question number or UUID once, at the edge. */

import type { Database } from 'bun:sqlite'
import type { QuestionIdentity } from '../../../shared/orch-contract.ts'
import { hasRecordIdShape } from '../../../shared/record-id.ts'
import { questionOpenSql } from './question-open.ts'

export type ParsedQuestionIdentifier =
  | { kind: 'number'; id: number }
  | { kind: 'record-id'; recordId: string }

type ParsedAnswerIdentifier =
  | { kind: 'question-number'; number: number }
  | { kind: 'run-number'; number: number }
  | { kind: 'run-record-id'; recordId: string }

export type AnswerIdentifierFacts = {
  identifier: ParsedAnswerIdentifier
  run: {
    recordId: string
    status: string
    hasOpenQuestionOwnedByCaller: boolean
  } | null
  question: {
    rootRecordId: string
    open: boolean
    ownedByCaller: boolean
  } | null
}

export type AnswerIdentifierDecision =
  | { kind: 'target'; runRecordId: string }
  | { kind: 'refuse'; reason: string }

const ACCEPTED_QUESTION_IDENTIFIERS = 'a positive decimal question number or a full question UUID'

export function questionIdentityMap(database: Database): QuestionIdentity[] {
  return database
    .query<QuestionIdentity, []>('SELECT number,record_id FROM question ORDER BY number')
    .all()
}

export function parseQuestionIdentifier(input: string | number): ParsedQuestionIdentifier {
  const given = String(input)
  if (/^[0-9]+$/.test(given)) {
    const id = Number(given)
    if (Number.isSafeInteger(id) && id > 0) return { kind: 'number', id }
  }
  if (hasRecordIdShape(given)) return { kind: 'record-id', recordId: given.toLowerCase() }
  throw new Error(
    `invalid question identifier ${JSON.stringify(given)}: expected ${ACCEPTED_QUESTION_IDENTIFIERS}`,
  )
}

export function resolveQuestionIdentifier(database: Database, input: string | number): string {
  const parsed = parseQuestionIdentifier(input)
  if (parsed.kind === 'number') {
    const row = database
      .query<{ record_id: string }, [number]>('SELECT record_id FROM question WHERE number=?')
      .get(parsed.id)
    if (row) return row.record_id
    throw new Error(`no question has number ${parsed.id}; pass ${ACCEPTED_QUESTION_IDENTIFIERS}`)
  }
  const row = database
    .query<{ record_id: string }, [string]>('SELECT record_id FROM question WHERE record_id=?')
    .get(parsed.recordId)
  if (row) return row.record_id
  throw new Error(
    `no question has UUID ${JSON.stringify(String(input))}; pass ${ACCEPTED_QUESTION_IDENTIFIERS}`,
  )
}

function parseAnswerIdentifier(input: string | number): ParsedAnswerIdentifier {
  const given = String(input)
  const question = given.match(/^q([0-9]+)$/)
  if (question) {
    const number = Number(question[1])
    if (Number.isSafeInteger(number) && number > 0) return { kind: 'question-number', number }
  }
  if (/^[0-9]+$/.test(given)) {
    const number = Number(given)
    if (Number.isSafeInteger(number) && number > 0) return { kind: 'run-number', number }
  }
  if (hasRecordIdShape(given)) return { kind: 'run-record-id', recordId: given.toLowerCase() }
  throw new Error(
    `invalid answer identifier ${JSON.stringify(given)}: expected q followed by a positive decimal question number, a positive decimal run number, or a full run UUID`,
  )
}

/** Chooses the answer target without database, process, or session access. */
export function answerIdentifierDecision(facts: AnswerIdentifierFacts): AnswerIdentifierDecision {
  const { identifier, question, run } = facts
  if (identifier.kind === 'run-record-id') {
    return run
      ? { kind: 'target', runRecordId: run.recordId }
      : { kind: 'refuse', reason: `no run matches ${JSON.stringify(identifier.recordId)}` }
  }
  if (identifier.kind === 'question-number') {
    return question
      ? { kind: 'target', runRecordId: question.rootRecordId }
      : { kind: 'refuse', reason: `no question has number ${identifier.number}` }
  }

  const number = identifier.number
  const runCanReceiveRuling = run?.status === 'asking' && run.hasOpenQuestionOwnedByCaller
  if (runCanReceiveRuling && question?.open) {
    return {
      kind: 'refuse',
      reason:
        `bare identifier ${number} is ambiguous between run:${number} (${run.recordId}) and q${number}; ` +
        `pass the run UUID or q${number}`,
    }
  }
  if (runCanReceiveRuling) return { kind: 'target', runRecordId: run.recordId }
  if (!run) {
    return {
      kind: 'refuse',
      reason: `run ${number} does not exist; to answer question q${number}, pass q${number}`,
    }
  }
  return {
    kind: 'refuse',
    reason:
      `run ${number} has no open question (status: ${run.status}); ` +
      `to answer question q${number}, pass q${number}`,
  }
}

export function resolveAnswerIdentifier(
  database: Database,
  input: string | number,
  callerSessionId: string | null,
): string {
  const identifier = parseAnswerIdentifier(input)
  const run =
    identifier.kind === 'question-number'
      ? null
      : (database
          .query<
            {
              record_id: string
              status: string
              owner_session_id: string | null
              open_count: number
            },
            [number | string]
          >(
            `SELECT requested.record_id, requested.status, root.session_id owner_session_id,
                    (SELECT COUNT(*) FROM question q JOIN run owner ON owner.record_id=q.run_record_id
                      WHERE (owner.record_id=root.record_id OR owner.parent_run_record_id=root.record_id)
                        AND ${questionOpenSql('q')}) open_count
               FROM run requested
               JOIN run root ON root.record_id=COALESCE(requested.parent_run_record_id,requested.record_id)
              WHERE ${identifier.kind === 'run-number' ? 'requested.number=?' : 'requested.record_id=?'}`,
          )
          .get(identifier.kind === 'run-number' ? identifier.number : identifier.recordId) ?? null)
  const questionNumber = identifier.kind === 'run-record-id' ? null : identifier.number
  const question =
    questionNumber === null
      ? null
      : (database
          .query<
            {
              root_record_id: string
              answered_at: string | null
              closed_at: string | null
              owner_session_id: string | null
            },
            [number]
          >(
            `SELECT root.record_id root_record_id, q.answered_at, q.closed_at,
                    root.session_id owner_session_id
               FROM question q
               JOIN run owner ON owner.record_id=q.run_record_id
               JOIN run root ON root.record_id=COALESCE(owner.parent_run_record_id,owner.record_id)
              WHERE q.number=?`,
          )
          .get(questionNumber) ?? null)
  const decision = answerIdentifierDecision({
    identifier,
    run: run && {
      recordId: run.record_id,
      status: run.status,
      hasOpenQuestionOwnedByCaller:
        callerSessionId !== null && run.owner_session_id === callerSessionId && run.open_count > 0,
    },
    question: question && {
      rootRecordId: question.root_record_id,
      open: question.answered_at === null && question.closed_at === null,
      ownedByCaller: callerSessionId !== null && question.owner_session_id === callerSessionId,
    },
  })
  if (decision.kind === 'refuse') throw new Error(decision.reason)
  return decision.runRecordId
}
