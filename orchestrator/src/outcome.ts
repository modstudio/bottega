// concern: outcome
import { realQuestions, type WorkerReply } from './contract.ts'
export type OutcomeRow = {
  id: number
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
  acceptedQuestions: NonNullable<WorkerReply['questions']>
  droppedQuestions: NonNullable<WorkerReply['questions']>
}

/** Classify the parsed worker reply against the measured repository change. */
export function finalizeWorkerReply<FailureKind extends string>(inputs: {
  reply: WorkerReply | null
  measuredFiles: string[] | null
  status: OutcomeStatus
  failureKind: FailureKind | 'contract' | 'other' | null
  error: string | null
  contractObjects?: number
}): WorkerFinalization<FailureKind> {
  const { reply } = inputs
  const questionsControlStatus = reply?.status === 'asking' || reply?.status === 'done'
  const acceptedQuestions = questionsControlStatus ? realQuestions(reply) : []
  const accepted = new Set(acceptedQuestions)
  const droppedQuestions = questionsControlStatus
    ? (reply?.questions ?? []).filter((item) => !accepted.has(item)) : []
  let { status, failureKind, error } = inputs

  if (reply?.status === 'asking' && acceptedQuestions.length === 0) {
    const rejected = reply.questions?.map((item) => JSON.stringify(item.question)).join(', ')
      || '(no question text)'
    status = 'failed'
    failureKind = 'contract'
    error = 'the worker returned asking without a real question and non-empty why; ' +
      `rejected question text: ${rejected}`
  }
  if (reply?.status === 'done' && reply.files_changed?.length === 0 &&
      reply.tests?.ran === false && inputs.measuredFiles?.length === 0 &&
      failureKind !== 'truncated') {
    status = 'failed'
    failureKind = 'other'
    error = 'reported done with no change and no test run'
  }
  if ((inputs.contractObjects ?? 0) > 1) {
    const note = `${inputs.contractObjects} contract objects in output; took the last`
    error = error ? `${error}\n${note}` : note
  }
  if (reply?.status === 'done' && acceptedQuestions.length) {
    status = 'asking'
    failureKind = null
    const note = 'status reclassified from done to asking: a worker with a real question has not finished'
    error = error ? `${error}\n${note}` : note
  }
  if (droppedQuestions.length && (acceptedQuestions.length || reply?.status === 'done')) {
    const count = droppedQuestions.length
    const rejected = droppedQuestions.map((item) => JSON.stringify(item.question)).join(', ')
    const note = `${count} invalid question${count === 1 ? '' : 's'} dropped; ` +
      `rejected question text: ${rejected}`
    error = error ? `${error}\n${note}` : note
  }
  return { status, failureKind, error, acceptedQuestions, droppedQuestions }
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

/** Decide the provisional terminal outcome from facts gathered by the caller. */
export function decideOutcome<FailureKind extends string>(
  inputs: OutcomeInputs<FailureKind>,
): {
  status: OutcomeStatus
  failureKind: FailureKind | 'idle' | 'contract' | 'other' | 'truncated' | 'timeout' | null
} {
  if (inputs.idleKilled && inputs.completedReply) {
    return { status: inputs.acceptedQuestions ? 'asking' : 'ok', failureKind: null }
  } else if (inputs.idleKilled && (inputs.collectedAsking || inputs.acceptedQuestions)) {
    return { status: 'asking', failureKind: null }
  } else if (inputs.idleKilled) {
    return { status: 'failed', failureKind: 'idle' }
  } else if (inputs.acpVendorStop) {
    return { status: 'failed', failureKind: inputs.acpFailureKind }
  } else if (inputs.replyFileError) {
    return { status: 'failed', failureKind: inputs.replyFilePresent ? 'contract' : 'other' }
  } else if (inputs.collectedAsking || inputs.acceptedQuestions) {
    return { status: 'asking', failureKind: null }
  } else if (inputs.outputCeilingReached) {
    return { status: 'failed', failureKind: 'truncated' }
  } else if (inputs.timedOut && inputs.completedReplyAtTimeout) {
    return { status: inputs.acceptedQuestions ? 'asking' : 'ok', failureKind: null }
  } else if (inputs.timedOut) {
    return { status: 'failed', failureKind: 'timeout' }
  } else if (inputs.replyError) {
    return { status: 'failed', failureKind: inputs.replyErrorFailureKind }
  } else if (inputs.exitCode === 0 && inputs.nonAnswer) {
    return { status: 'failed', failureKind: inputs.nonAnswerFailureKind }
  } else if (inputs.acceptedQuestions) {
    return { status: 'asking', failureKind: null }
  } else if (inputs.contractStatus === 'asking') {
    return { status: 'failed', failureKind: 'contract' }
  } else if (inputs.contractStatus === 'refused') {
    return { status: inputs.exitCode === 0 ? 'ok' : 'failed', failureKind: null }
  } else if (inputs.exitCode !== 0 && inputs.contractStatus === 'done') {
    return { status: 'failed', failureKind: inputs.completedContractFailureKind }
  } else if (inputs.missingRequiredContract) {
    return { status: 'failed', failureKind: inputs.missingContractFailureKind }
  }

  const status = inputs.exitCode === 0 && inputs.outputPresent ? 'ok' : 'failed'
  return { status, failureKind: status === 'failed' ? inputs.defaultFailureKind : null }
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
    return { terminal: true, ok: true, line: `asking - orch inbox (or orch answer ${row.id})` }
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
  status: string; error: string | null; failure_kind: string | null; exit_code: number | null
}): string {
  const kind = row.failure_kind ?? row.status
  const code = row.exit_code == null ? '' : `, exit ${row.exit_code}`
  const error = (row.error ?? 'no error recorded').replace(/\s+/g, ' ').trim()
  return `${kind}${code}: ${error}`
}
