// concern: run-answer
/** Resolves the identifier accepted by `question answer` without delivering a ruling. */

import type { Database } from 'bun:sqlite'
import { storedMachineNames } from '../../../shared/machine-config.ts'
import {
  formatReference,
  parseReference,
  REFERENCE_PREFIXES,
  type ReferenceQualifier,
} from '../../../shared/reference.ts'
import { ResolutionMissError } from '../identity/identity-local-run.ts'
import { resolve } from '../identity/identity.ts'
import { identityContext } from '../identity/identity-context.ts'
import { questionsById } from '../question-store/question-store-read.ts'
import type { MachineIdentifierNames } from '../record/machine-name.ts'
import { questionsForRunChain } from './question-open.ts'

export type ParsedAnswerIdentifier =
  | { kind: 'question-number'; number: number; qualifier?: ReferenceQualifier }
  | { kind: 'run-number'; number: number; qualifier?: ReferenceQualifier }
  | { kind: 'record-id'; recordId: string; qualifier?: ReferenceQualifier }

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

const ANSWER_IDENTIFIER_FORMS =
  'q<n>, <project>#q<n>, a positive decimal run number, r<n>, <machine>/<n>, <machine>/r<n>, or a full UUID'

function questionReference(
  identifier: Exclude<ParsedAnswerIdentifier, { kind: 'run-number' }>,
): string {
  return identifier.kind === 'question-number'
    ? qualifiedReference(identifier.qualifier, `${REFERENCE_PREFIXES.question}${identifier.number}`)
    : identifier.recordId
}

function qualifiedReference(qualifier: ReferenceQualifier | undefined, value: string): string {
  if (!qualifier) return value
  return `${qualifier.value}${qualifier.kind === 'project' ? '#' : '/'}${value}`
}

function withQualifier<T extends ParsedAnswerIdentifier>(
  identifier: T,
  qualifier: ReferenceQualifier | null,
): T {
  return qualifier ? { ...identifier, qualifier } : identifier
}

function waitingDescription(rootRecordId: string, questionNumbers: number[]): string {
  if (questionNumbers.length === 0) return `run ${rootRecordId} has no open questions`
  return `run ${rootRecordId} is waiting on ${questionNumbers.map((number) => formatReference('question', number)).join(', ')}`
}

function explicitQuestionRemedy(questionNumbers: number[]): string {
  const references = questionNumbers.map((number) => formatReference('question', number)).join(', ')
  return `answer ${questionNumbers.length === 1 ? 'it' : 'them'} explicitly with ${references}`
}

export function parseAnswerIdentifier(
  input: string | number,
  _names: MachineIdentifierNames | null = storedMachineNames(),
): ParsedAnswerIdentifier {
  const original = String(input)
  let reference: ReturnType<typeof parseReference>
  try {
    reference = parseReference(original, 'run')
  } catch {
    throw new Error(
      `invalid answer identifier ${JSON.stringify(original)}: expected ${ANSWER_IDENTIFIER_FORMS}`,
    )
  }
  if (reference.value.kind === 'label' && reference.value.prefix === REFERENCE_PREFIXES.question) {
    if (reference.qualifier?.kind === 'machine')
      throw new Error(
        'question references cannot use a machine qualifier; pass a <project>#q<number> reference',
      )
    return withQualifier(
      { kind: 'question-number', number: reference.value.number },
      reference.qualifier,
    )
  }
  if (reference.value.kind === 'label' && reference.value.prefix === REFERENCE_PREFIXES.run)
    return withQualifier(
      { kind: 'run-number', number: reference.value.number },
      reference.qualifier,
    )
  if (reference.value.kind === 'number')
    return withQualifier(
      { kind: 'run-number', number: reference.value.number },
      reference.qualifier,
    )
  if (reference.value.kind === 'record-id')
    return withQualifier(
      { kind: 'record-id', recordId: reference.value.recordId },
      reference.qualifier,
    )
  throw new Error(
    `invalid answer identifier ${JSON.stringify(original)}: expected ${ANSWER_IDENTIFIER_FORMS}`,
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
        : `no run or question matches ${JSON.stringify(identifier.recordId)}; pass ${ANSWER_IDENTIFIER_FORMS}`,
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

function isResolutionMiss(error: unknown): boolean {
  return error instanceof ResolutionMissError
}

async function readResolvedRunNumberFacts(
  database: Database,
  reference: string | number,
  context: ReturnType<typeof identityContext>,
  callerSessionId: string | null,
): Promise<AnswerRunFacts | null> {
  let run: Awaited<ReturnType<typeof resolve>> | null = null
  try {
    run = await resolve(reference, context, 'run')
  } catch (error) {
    if (!isResolutionMiss(error)) throw error
  }
  if (!run) return null
  return readRunFacts(database, run.recordId, callerSessionId)
}

async function openQuestionNumbers(database: Database, rootRecordId: string): Promise<number[]> {
  return (await questionsForRunChain(database, rootRecordId))
    .filter(({ answered_at, closed_at }) => answered_at === null && closed_at === null)
    .map(({ number }) => Number(number))
    .sort((a, b) => a - b)
}

async function readRunFacts(
  database: Database,
  runRecordId: string,
  callerSessionId: string | null,
): Promise<AnswerRunFacts | null> {
  const row =
    database
      .query<
        {
          record_id: string
          root_record_id: string
          status: string
          owner_session_id: string | null
        },
        [string]
      >(
        `SELECT requested.record_id, requested.status, root.record_id root_record_id,
                root.session_id owner_session_id
           FROM run requested
           JOIN run root ON root.record_id=COALESCE(requested.parent_run_record_id,requested.record_id)
          WHERE requested.record_id=?`,
      )
      .get(runRecordId) ?? null
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
  context: ReturnType<typeof identityContext>,
): Promise<AnswerQuestionFacts | null> {
  let recordId: string
  if (identifier.kind === 'record-id') recordId = identifier.recordId
  else {
    try {
      recordId = (
        await resolve(
          qualifiedReference(identifier.qualifier, formatReference('question', identifier.number)),
          context,
          'question',
        )
      ).recordId
    } catch (error) {
      if (isResolutionMiss(error)) return null
      throw error
    }
  }
  const row = (await questionsById(database, [recordId]))[0]
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
  const context = identityContext(database, { session: callerSessionId })
  if (identifier.kind === 'question-number') {
    const question = await resolve(
      qualifiedReference(
        identifier.qualifier,
        `${REFERENCE_PREFIXES.question}${identifier.number}`,
      ),
      context,
      'question',
    )
    const normalized = { kind: 'record-id' as const, recordId: question.recordId }
    const decision = answerIdentifierDecision({
      identifier,
      run: null,
      question: await readQuestionFacts(database, normalized, context),
    })
    if (decision.kind === 'refuse') throw new Error(decision.reason)
    return decision.runRecordId
  }
  if (identifier.kind === 'run-number') {
    const runReference = qualifiedReference(identifier.qualifier, String(identifier.number))
    const decision = answerIdentifierDecision({
      identifier,
      run: await readResolvedRunNumberFacts(database, runReference, context, callerSessionId),
      question:
        identifier.qualifier?.kind === 'machine'
          ? null
          : await readQuestionFacts(database, identifier, context),
    })
    if (decision.kind === 'refuse') throw new Error(decision.reason)
    return decision.runRecordId
  }
  const resolved = await resolve(
    qualifiedReference(identifier.qualifier, identifier.recordId),
    context,
  )
  const normalized = { kind: 'record-id' as const, recordId: resolved.recordId }
  const decision = answerIdentifierDecision({
    identifier: normalized,
    run:
      resolved.kind === 'run'
        ? await readRunFacts(database, resolved.recordId, callerSessionId)
        : null,
    question:
      resolved.kind === 'question' ? await readQuestionFacts(database, normalized, context) : null,
  })
  if (decision.kind === 'refuse') throw new Error(decision.reason)
  return decision.runRecordId
}
