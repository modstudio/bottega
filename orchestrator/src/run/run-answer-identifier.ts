// concern: run-answer
/** Resolves the identifier accepted by `question answer` without delivering a ruling. */

import type { Database } from 'bun:sqlite'
import { storedMachineNames } from '../../../shared/machine-config.ts'
import {
  decideMachineLabel,
  type MachineIdentifierNames,
  MachineLabelRefusal,
} from '../record/machine-name.ts'
import { questionOpenSql } from './question-open.ts'
import { classifyRunIdentifier } from './run-identifier-grammar.ts'

export type ParsedAnswerIdentifier =
  | { kind: 'question-number'; number: number }
  | { kind: 'run-number'; number: number }
  | { kind: 'record-id'; recordId: string }

type AnswerRunFacts = {
  recordId: string
  rootRecordId: string
  status: string
  ownedByCaller: boolean
  openQuestionNumbers: number[]
}

type AnswerQuestionFacts = {
  rootRecordId: string
  open: boolean
  state: 'open' | 'ruled' | 'closed'
  openQuestionNumbers: number[]
}

export type AnswerIdentifierFacts = {
  identifier: ParsedAnswerIdentifier
  run: AnswerRunFacts | null
  question: AnswerQuestionFacts | null
}

export type AnswerIdentifierDecision =
  | { kind: 'target'; runRecordId: string }
  | { kind: 'refuse'; reason: string }

function questionReference(
  identifier: Exclude<ParsedAnswerIdentifier, { kind: 'run-number' }>,
): string {
  return identifier.kind === 'question-number' ? `q${identifier.number}` : identifier.recordId
}

function waitingDescription(rootRecordId: string, questionNumbers: number[]): string {
  if (questionNumbers.length === 0) return `run ${rootRecordId} has no open questions`
  return `run ${rootRecordId} is waiting on ${questionNumbers.map((number) => `q${number}`).join(', ')}`
}

function explicitQuestionRemedy(questionNumbers: number[]): string {
  const references = questionNumbers.map((number) => `q${number}`).join(', ')
  return `answer ${questionNumbers.length === 1 ? 'it' : 'them'} explicitly with ${references}`
}

export function parseAnswerIdentifier(
  input: string | number,
  names: MachineIdentifierNames | null = storedMachineNames(),
): ParsedAnswerIdentifier {
  const original = String(input)
  const label = decideMachineLabel(original, names)
  if (label.kind === 'refused') throw new MachineLabelRefusal(label.reason)
  const given = label.kind === 'bare' ? label.remainder : original
  const question = given.match(/^q([0-9]+)$/)
  if (question) {
    const number = Number(question[1])
    if (Number.isSafeInteger(number) && number > 0) return { kind: 'question-number', number }
  }
  const runIdentifier = classifyRunIdentifier(given, names)
  if (runIdentifier?.kind === 'number') return { kind: 'run-number', number: runIdentifier.number }
  if (runIdentifier?.kind === 'record-id')
    return { kind: 'record-id', recordId: runIdentifier.recordId }
  throw new Error(
    `invalid answer identifier ${JSON.stringify(original)}: expected q followed by a positive decimal question number, name/q followed by a positive decimal question number, a positive decimal run number, name/number, or a full run or question UUID`,
  )
}

function explicitQuestionDecision(
  identifier: Exclude<ParsedAnswerIdentifier, { kind: 'run-number' }>,
  run: AnswerRunFacts | null,
  question: AnswerQuestionFacts | null,
): AnswerIdentifierDecision {
  if (question) {
    if (question.open) return { kind: 'target', runRecordId: question.rootRecordId }
    const state = question.state === 'ruled' ? 'already ruled on' : 'closed'
    return {
      kind: 'refuse',
      reason:
        `${questionReference(identifier)} is ${state}; ` +
        waitingDescription(question.rootRecordId, question.openQuestionNumbers),
    }
  }
  if (identifier.kind === 'record-id' && run) return { kind: 'target', runRecordId: run.recordId }
  return {
    kind: 'refuse',
    reason:
      identifier.kind === 'question-number'
        ? `no question has number ${identifier.number}`
        : `no run or question matches ${JSON.stringify(identifier.recordId)}; pass qN, a full question UUID, a positive decimal run number, or a full run UUID`,
  }
}

function runNumberDecision(
  number: number,
  run: AnswerRunFacts | null,
  question: AnswerQuestionFacts | null,
): AnswerIdentifierDecision {
  if (!run) {
    return {
      kind: 'refuse',
      reason: `run ${number} does not exist; to answer question q${number}, pass q${number}`,
    }
  }
  const runCanReceiveRuling =
    run.status === 'asking' && run.ownedByCaller && run.openQuestionNumbers.length > 0
  if (run.status === 'asking' && question && question.rootRecordId !== run.rootRecordId) {
    return {
      kind: 'refuse',
      reason:
        `bare identifier ${number} is ambiguous between run:${number} (${run.recordId}) and q${number}; ` +
        `pass the run UUID or q${number}`,
    }
  }
  if (runCanReceiveRuling) return { kind: 'target', runRecordId: run.recordId }
  if (run.openQuestionNumbers.length === 0) {
    return {
      kind: 'refuse',
      reason:
        `run ${number} has no open question (status: ${run.status}); ` +
        `to answer question q${number}, pass q${number}`,
    }
  }
  if (!run.ownedByCaller) {
    return {
      kind: 'refuse',
      reason:
        `run ${number} has open questions but they are not owned by the current session; ` +
        explicitQuestionRemedy(run.openQuestionNumbers),
    }
  }
  return {
    kind: 'refuse',
    reason:
      `run ${number} is not asking (status: ${run.status}); ` +
      explicitQuestionRemedy(run.openQuestionNumbers),
  }
}

/** Chooses the answer target using only facts gathered at the command edge. */
export function answerIdentifierDecision(facts: AnswerIdentifierFacts): AnswerIdentifierDecision {
  const { identifier, question, run } = facts
  return identifier.kind === 'run-number'
    ? runNumberDecision(identifier.number, run, question)
    : explicitQuestionDecision(identifier, run, question)
}

function openQuestionNumbers(database: Database, rootRecordId: string): number[] {
  return database
    .query<{ number: number }, [string, string]>(
      `SELECT q.number
         FROM question q
         JOIN run owner ON owner.record_id=q.run_record_id
        WHERE (owner.record_id=? OR owner.parent_run_record_id=?) AND ${questionOpenSql('q')}
        ORDER BY q.number`,
    )
    .all(rootRecordId, rootRecordId)
    .map((row) => row.number)
}

function readRunFacts(
  database: Database,
  identifier: ParsedAnswerIdentifier,
  callerSessionId: string | null,
): AnswerRunFacts | null {
  if (identifier.kind === 'question-number') return null
  const row =
    database
      .query<
        {
          record_id: string
          root_record_id: string
          status: string
          owner_session_id: string | null
        },
        [number | string]
      >(
        `SELECT requested.record_id, requested.status, root.record_id root_record_id,
                root.session_id owner_session_id
           FROM run requested
           JOIN run root ON root.record_id=COALESCE(requested.parent_run_record_id,requested.record_id)
          WHERE ${identifier.kind === 'run-number' ? 'requested.number=?' : 'requested.record_id=?'}`,
      )
      .get(identifier.kind === 'run-number' ? identifier.number : identifier.recordId) ?? null
  if (!row) return null
  return {
    recordId: row.record_id,
    rootRecordId: row.root_record_id,
    status: row.status,
    ownedByCaller: callerSessionId !== null && row.owner_session_id === callerSessionId,
    openQuestionNumbers: openQuestionNumbers(database, row.root_record_id),
  }
}

function readQuestionFacts(
  database: Database,
  identifier: ParsedAnswerIdentifier,
): AnswerQuestionFacts | null {
  const byRecordId = identifier.kind === 'record-id'
  const value = byRecordId ? identifier.recordId : identifier.number
  const row =
    database
      .query<
        { root_record_id: string; open: number; answered_at: string | null },
        [number | string]
      >(
        `SELECT root.record_id root_record_id, (${questionOpenSql('q')}) open, q.answered_at
           FROM question q
           JOIN run owner ON owner.record_id=q.run_record_id
           JOIN run root ON root.record_id=COALESCE(owner.parent_run_record_id,owner.record_id)
          WHERE ${byRecordId ? 'q.record_id' : 'q.number'}=?`,
      )
      .get(value) ?? null
  if (!row) return null
  return {
    rootRecordId: row.root_record_id,
    open: Boolean(row.open),
    state: row.open ? 'open' : row.answered_at ? 'ruled' : 'closed',
    openQuestionNumbers: openQuestionNumbers(database, row.root_record_id),
  }
}

export function resolveAnswerIdentifier(
  database: Database,
  input: string | number,
  callerSessionId: string | null,
): string {
  const identifier = parseAnswerIdentifier(input)
  const decision = answerIdentifierDecision({
    identifier,
    run: readRunFacts(database, identifier, callerSessionId),
    question: readQuestionFacts(database, identifier),
  })
  if (decision.kind === 'refuse') throw new Error(decision.reason)
  return decision.runRecordId
}
