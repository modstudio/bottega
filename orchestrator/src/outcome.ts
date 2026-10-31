// concern: outcome
import { PLATFORM_SLUG } from '../../shared/brand.ts'
export const GENERIC_QUESTION_TOKENS = ['placeholder', 'tbd', 'question', 'todo'] as const
export const SCHEMA_ENVELOPE_ERROR_PREFIX = 'schema-envelope: '

/** Whether an invalid reply is the expected JSON Schema instead of an instance of it. */
export function isSchemaEnvelopeReply(value: unknown, schema: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return false
  const candidate = value as Record<string, unknown>
  const required = (schema as { required?: unknown }).required
  const properties = candidate.properties
  if (
    candidate.type !== 'object' ||
    properties === null ||
    typeof properties !== 'object' ||
    Array.isArray(properties) ||
    !Array.isArray(required) ||
    required.length === 0 ||
    !required.every((key): key is string => typeof key === 'string')
  )
    return false
  return required.every((key) => Object.hasOwn(properties, key))
}

/** Name a schema-envelope contract error without accepting or rewriting its reply. */
export function schemaEnvelopeContractError(
  existingError: string | null,
  value: unknown,
  schema: unknown,
): string | null {
  if (!existingError || !isSchemaEnvelopeReply(value, schema)) return existingError
  return (
    `${SCHEMA_ENVELOPE_ERROR_PREFIX}reply.json held the schema itself rather than an instance of it. ` +
    existingError
  )
}

type WorkerQuestion = {
  question: string
  options?: string[] | null
  recommendation?: string | null
  why?: string | null
}

type FinalizationReply = {
  status: 'done' | 'asking' | 'refused'
  files_changed?: string[] | null
  questions?: WorkerQuestion[] | null
  tests?: { ran?: boolean } | null
}

/** Invisible format characters are not content, even though trim() preserves them. */
function normalizeQuestionField(value: string | null | undefined): string {
  return (value ?? '').replace(/\p{Cf}/gu, '').trim()
}

/** Whether one schema-valid question contains both a decision and its consequence. */
function isRealQuestion(item: WorkerQuestion): boolean {
  const generic = new Set<string>(GENERIC_QUESTION_TOKENS)
  const question = normalizeQuestionField(item.question)
    .replace(/^\p{P}+|\p{P}+$/gu, '')
    .trim()
  const why = normalizeQuestionField(item.why)
  return question.length > 0 && !generic.has(question.toLowerCase()) && why.length > 0
}

/** The usable question subset of a schema-valid worker reply. */
export function realQuestions(r: FinalizationReply | null | undefined): WorkerQuestion[] {
  if (!r?.questions?.length) return []
  return r.questions.filter(isRealQuestion)
}

/** A reply contains a decision for the architect when at least one question is real. */
export function hasRealQuestions(r: FinalizationReply | null | undefined): boolean {
  return realQuestions(r).length > 0
}
export type OutcomeRow = {
  record_id: string
  status: string
  error?: string | null
  failure_kind?: string | null
  exit_code?: number | null
  delivery?: unknown
  quality?: unknown
}

export type OutcomeStatus = 'ok' | 'asking' | 'failed'

export type WorkerFinalization<FailureKind extends string = string> = {
  status: OutcomeStatus
  failureKind: FailureKind | 'contract' | 'other' | null
  error: string | null
  acceptedQuestions: WorkerQuestion[]
  droppedQuestions: WorkerQuestion[]
}

type FinalizationInputs<FailureKind extends string> = {
  reply: FinalizationReply | null
  measuredFiles: string[] | null
  turnChanged: boolean | null
  status: OutcomeStatus
  failureKind: FailureKind | 'contract' | 'other' | null
  error: string | null
  contractObjects?: number
}

type FinalizationDecision<FailureKind extends string> = Pick<
  WorkerFinalization<FailureKind>,
  'status' | 'failureKind' | 'error'
>

function appendOutcomeNote(error: string | null, note: string): string {
  return error ? `${error}\n${note}` : note
}

function rejectEmptyAsking<FailureKind extends string>(
  reply: FinalizationReply | null,
  acceptedQuestions: WorkerQuestion[],
  decision: FinalizationDecision<FailureKind>,
): FinalizationDecision<FailureKind> {
  if (reply?.status !== 'asking' || acceptedQuestions.length > 0) return decision
  const rejected =
    reply.questions?.map((item) => JSON.stringify(item.question)).join(', ') || '(no question text)'
  return {
    status: 'failed',
    failureKind: 'contract',
    error:
      'the worker returned asking without a real question and non-empty why; ' +
      `rejected question text: ${rejected}`,
  }
}

function rejectEmptyDone<FailureKind extends string>(
  inputs: FinalizationInputs<FailureKind>,
  decision: FinalizationDecision<FailureKind>,
): FinalizationDecision<FailureKind> {
  const { reply } = inputs
  if (
    reply?.status !== 'done' ||
    reply.files_changed?.length !== 0 ||
    reply.tests?.ran !== false ||
    inputs.measuredFiles?.length !== 0 ||
    decision.failureKind === 'truncated'
  )
    return decision
  return {
    status: 'failed',
    failureKind: 'other',
    error: 'reported done with no change and no test run',
  }
}

function reclassifyDoneAsking<FailureKind extends string>(
  reply: FinalizationReply | null,
  acceptedQuestions: WorkerQuestion[],
  decision: FinalizationDecision<FailureKind>,
): FinalizationDecision<FailureKind> {
  if (reply?.status !== 'done' || acceptedQuestions.length === 0) return decision
  const note =
    'status reclassified from done to asking: a worker with a real question has not finished'
  return { status: 'asking', failureKind: null, error: appendOutcomeNote(decision.error, note) }
}

function annotateDroppedQuestions<FailureKind extends string>(
  reply: FinalizationReply | null,
  acceptedQuestions: WorkerQuestion[],
  droppedQuestions: WorkerQuestion[],
  decision: FinalizationDecision<FailureKind>,
): FinalizationDecision<FailureKind> {
  if (droppedQuestions.length === 0 || (acceptedQuestions.length === 0 && reply?.status !== 'done'))
    return decision
  const count = droppedQuestions.length
  const rejected = droppedQuestions.map((item) => JSON.stringify(item.question)).join(', ')
  const note =
    `${count} invalid question${count === 1 ? '' : 's'} dropped; ` +
    `rejected question text: ${rejected}`
  return { ...decision, error: appendOutcomeNote(decision.error, note) }
}

function annotateUnchangedTurn<FailureKind extends string>(
  inputs: FinalizationInputs<FailureKind>,
  decision: FinalizationDecision<FailureKind>,
): FinalizationDecision<FailureKind> {
  if (inputs.reply?.status !== 'done' || inputs.turnChanged !== false || decision.status !== 'ok')
    return decision
  const note =
    'this turn changed nothing: the tree and tip are as it started; files_changed in the reply describes earlier work'
  return { ...decision, error: appendOutcomeNote(decision.error, note) }
}

/** Classify the parsed worker reply against the measured repository change. */
export function finalizeWorkerReply<FailureKind extends string>(
  inputs: FinalizationInputs<FailureKind>,
): WorkerFinalization<FailureKind> {
  const { reply } = inputs
  const questionsControlStatus = reply?.status === 'asking' || reply?.status === 'done'
  const acceptedQuestions = questionsControlStatus ? realQuestions(reply) : []
  const accepted = new Set(acceptedQuestions)
  const droppedQuestions = questionsControlStatus
    ? (reply?.questions ?? []).filter((item) => !accepted.has(item))
    : []
  let decision: FinalizationDecision<FailureKind> = inputs
  decision = rejectEmptyAsking(reply, acceptedQuestions, decision)
  decision = rejectEmptyDone(inputs, decision)
  if ((inputs.contractObjects ?? 0) > 1) {
    const note = `${inputs.contractObjects} contract objects in output; took the last`
    decision = { ...decision, error: appendOutcomeNote(decision.error, note) }
  }
  decision = reclassifyDoneAsking(reply, acceptedQuestions, decision)
  decision = annotateDroppedQuestions(reply, acceptedQuestions, droppedQuestions, decision)
  decision = annotateUnchangedTurn(inputs, decision)
  return { ...decision, acceptedQuestions, droppedQuestions }
}

export type OutcomeInputs<FailureKind extends string = string> = {
  idleKilled: boolean
  completedReply: boolean
  collectedAsking: boolean
  acceptedQuestions: boolean
  acpVendorStop: boolean
  acpFailureKind: FailureKind
  replyFileError: boolean
  replyFilePresent: boolean
  outputCeilingReached: boolean
  timedOut: boolean
  completedReplyAtTimeout: boolean
  replyError: boolean
  replyErrorFailureKind: FailureKind
  nonAnswer: boolean
  nonAnswerFailureKind: FailureKind
  contractStatus: 'done' | 'asking' | 'refused' | null
  exitCode: number
  completedContractFailureKind: FailureKind
  missingRequiredContract: boolean
  missingContractFailureKind: FailureKind
  outputPresent: boolean
  defaultFailureKind: FailureKind
}

type OutcomeDecision<FailureKind extends string> = {
  status: OutcomeStatus
  failureKind: FailureKind | 'idle' | 'contract' | 'other' | 'truncated' | 'timeout' | null
}

export type OutcomeRule =
  | 'idle-completed'
  | 'idle-asking'
  | 'idle'
  | 'acp-vendor-stop'
  | 'reply-file-mismatch'
  | 'asking'
  | 'truncated'
  | 'timeout-completed'
  | 'timeout'
  | 'reply-error'
  | 'non-answer'
  | 'missing-reply-contract'
  | 'contract-asking'
  | 'refused'
  | 'completed-then-ended'
  | 'missing-writer-contract'
  | 'default'

function decideStopOutcomeRule<FailureKind extends string>(
  inputs: OutcomeInputs<FailureKind>,
): OutcomeRule | null {
  if (inputs.idleKilled && inputs.completedReply) return 'idle-completed'
  if (inputs.idleKilled && (inputs.collectedAsking || inputs.acceptedQuestions)) {
    return 'idle-asking'
  }
  if (inputs.idleKilled) return 'idle'
  if (inputs.acpVendorStop) return 'acp-vendor-stop'
  return null
}

function decideReplyCollectionOutcomeRule<FailureKind extends string>(
  inputs: OutcomeInputs<FailureKind>,
): OutcomeRule | null {
  if (inputs.replyFileError && inputs.replyFilePresent) return 'reply-file-mismatch'
  if (inputs.collectedAsking || inputs.acceptedQuestions) return 'asking'
  return null
}

function decideLimitOutcomeRule<FailureKind extends string>(
  inputs: OutcomeInputs<FailureKind>,
): OutcomeRule | null {
  if (inputs.outputCeilingReached) return 'truncated'
  if (inputs.timedOut && inputs.completedReplyAtTimeout) return 'timeout-completed'
  if (inputs.timedOut) return 'timeout'
  return null
}

function decideContractOutcomeRule<FailureKind extends string>(
  inputs: OutcomeInputs<FailureKind>,
): OutcomeRule | null {
  if (inputs.replyError) return 'reply-error'
  if (
    inputs.exitCode === 0 &&
    inputs.nonAnswer &&
    (!inputs.replyFileError || inputs.outputPresent)
  ) {
    return 'non-answer'
  }
  if (inputs.replyFileError) return 'missing-reply-contract'
  if (inputs.contractStatus === 'asking') return 'contract-asking'
  if (inputs.contractStatus === 'refused') return 'refused'
  if (inputs.exitCode !== 0 && inputs.contractStatus === 'done') return 'completed-then-ended'
  if (inputs.missingRequiredContract) return 'missing-writer-contract'
  return null
}

/** Name the first terminal rule that applies, in precedence order. */
export function decideOutcomeRule<FailureKind extends string>(
  inputs: OutcomeInputs<FailureKind>,
): OutcomeRule {
  return (
    decideStopOutcomeRule(inputs) ??
    decideReplyCollectionOutcomeRule(inputs) ??
    decideLimitOutcomeRule(inputs) ??
    decideContractOutcomeRule(inputs) ??
    'default'
  )
}

/** Decide the provisional terminal outcome from facts gathered by the caller. */
export function decideOutcome<FailureKind extends string>(
  inputs: OutcomeInputs<FailureKind>,
): OutcomeDecision<FailureKind> {
  const rule = decideOutcomeRule(inputs)
  const completed = (): OutcomeDecision<FailureKind> => ({
    status: inputs.acceptedQuestions ? 'asking' : 'ok',
    failureKind: null,
  })
  const failed = (failureKind: OutcomeDecision<FailureKind>['failureKind']) => ({
    status: 'failed' as const,
    failureKind,
  })
  const defaultOutcome = (): OutcomeDecision<FailureKind> => {
    const status = inputs.exitCode === 0 && inputs.outputPresent ? 'ok' : 'failed'
    return { status, failureKind: status === 'failed' ? inputs.defaultFailureKind : null }
  }
  const outcomes: Record<OutcomeRule, () => OutcomeDecision<FailureKind>> = {
    'idle-completed': completed,
    'idle-asking': () => ({ status: 'asking', failureKind: null }),
    idle: () => failed('idle'),
    'acp-vendor-stop': () => failed(inputs.acpFailureKind),
    'reply-file-mismatch': () => failed('contract'),
    asking: () => ({ status: 'asking', failureKind: null }),
    truncated: () => failed('truncated'),
    'timeout-completed': completed,
    timeout: () => failed('timeout'),
    'reply-error': () => failed(inputs.replyErrorFailureKind),
    'non-answer': () => failed(inputs.nonAnswerFailureKind),
    'missing-reply-contract': () => failed('contract'),
    'contract-asking': () => failed('contract'),
    refused: () => ({ status: inputs.exitCode === 0 ? 'ok' : 'failed', failureKind: null }),
    'completed-then-ended': () => failed(inputs.completedContractFailureKind),
    'missing-writer-contract': () => failed(inputs.missingContractFailureKind),
    default: defaultOutcome,
  }
  return outcomes[rule]()
}

/** One short phrase for a column that has room for one. */
export function label(
  delivery: 'none' | 'partial' | 'full' | null,
  quality: 'wrong' | 'mixed' | 'right' | null,
): string {
  if (!delivery) return '—'
  if (delivery === 'none') return 'no answer'
  if (delivery === 'partial') return `part/${quality}`
  return quality ?? '—'
}

/** The caller-facing meaning of a run status, shared by every reporting command. */
export function outcomeOf(row: OutcomeRow): { terminal: boolean; ok: boolean; line: string } {
  if (row.status === 'running') return { terminal: false, ok: false, line: 'running' }
  if (row.status === 'asking') {
    return {
      terminal: true,
      ok: true,
      line: `asking - ${PLATFORM_SLUG} question inbox (or ${PLATFORM_SLUG} question answer ${row.record_id})`,
    }
  }
  if (row.status === 'ok') {
    const line = Object.hasOwn(row, 'delivery')
      ? label(row.delivery as never, row.quality as never)
      : 'ok'
    return { terminal: true, ok: true, line }
  }
  return { terminal: true, ok: false, line: row.status }
}

/** The single-line failure summary shared by result and wait. */
export function failureReason(row: {
  status: string
  error: string | null
  failure_kind: string | null
  exit_code: number | null
}): string {
  const kind = row.failure_kind ?? row.status
  const code = row.exit_code == null ? '' : `, exit ${row.exit_code}`
  const error = (row.error ?? 'no error recorded').replace(/\s+/g, ' ').trim()
  return `${kind}${code}: ${error}`
}
