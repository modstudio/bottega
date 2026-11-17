// concern: run-answer
/** Resolves the identifier accepted by `question answer` without delivering a ruling. */

import type { Database } from 'bun:sqlite'
import { storedMachineNames } from '../../../shared/machine-config.ts'
import { questionByNumber, questionsById } from '../question-store/question-store-read.ts'
import { type MachineIdentifierNames, stripMachineLabel } from '../record/machine-name.ts'
import { questionsForRunChain } from './question-open.ts'
import { classifyBareRunIdentifier } from './run-identifier-grammar.ts'

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
  const given = stripMachineLabel(original, names)
  const question = given.match(/^q([0-9]+)$/)
  if (question) {
    const number = Number(question[1])
    if (Number.isSafeInteger(number) && number > 0) return { kind: 'question-number', number }
  }
  const runIdentifier = classifyBareRunIdentifier(given)
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

async function openQuestionNumbers(database: Database, rootRecordId: string): Promise<number[]> {
  return (await questionsForRunChain(database, rootRecordId))
    .filter(({ answered_at, closed_at }) => answered_at === null && closed_at === null)
    .map(({ number }) => Number(number))
    .sort((a, b) => a - b)
}

async function readRunFacts(
  database: Database,
  identifier: ParsedAnswerIdentifier,
  callerSessionId: string | null,
): Promise<AnswerRunFacts | null> {
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
    openQuestionNumbers: await openQuestionNumbers(database, row.root_record_id),
  }
}

async function readQuestionFacts(
  database: Database,
  identifier: ParsedAnswerIdentifier,
): Promise<AnswerQuestionFacts | null> {
  const localProjectId =
    identifier.kind === 'question-number'
      ? database
          .query<{ project_record_id: string | null }, [number]>(
            `SELECT COALESCE(owner.project_record_id,cursor.project_record_id) project_record_id
             FROM question q LEFT JOIN run owner ON owner.record_id=q.run_record_id
             LEFT JOIN workflow_cursor cursor ON cursor.record_id=q.workflow_cursor_record_id
             WHERE q.number=?`,
          )
          .get(identifier.number)?.project_record_id
      : null
  if (identifier.kind === 'question-number' && !localProjectId)
    throw new Error(
      `question ${identifier.number} has no locally resolved record space; pass the question UUID`,
    )
  const row =
    identifier.kind === 'record-id'
      ? (await questionsById(database, [identifier.recordId]))[0]
      : await questionByNumber(database, identifier.number, localProjectId!)
  if (!row) return null
  const runId = String(row.run_record_id)
  const rootRecordId =
    database
      .query<{ root_id: string }, [string]>(
        'SELECT COALESCE(parent_run_record_id,record_id) root_id FROM run WHERE record_id=?',
      )
      .get(runId)?.root_id ?? runId
  const open = row.answered_at === null && row.closed_at === null
  return {
    rootRecordId,
    open,
    state: open ? 'open' : row.answered_at ? 'ruled' : 'closed',
    openQuestionNumbers: await openQuestionNumbers(database, rootRecordId),
  }
}

export async function resolveAnswerIdentifier(
  database: Database,
  input: string | number,
  callerSessionId: string | null,
): Promise<string> {
  const identifier = parseAnswerIdentifier(input)
  const decision = answerIdentifierDecision({
    identifier,
    run: await readRunFacts(database, identifier, callerSessionId),
    question: await readQuestionFacts(database, identifier),
  })
  if (decision.kind === 'refuse') throw new Error(decision.reason)
  return decision.runRecordId
}
