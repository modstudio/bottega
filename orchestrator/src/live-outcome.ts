// concern: live-outcome
import { redactSecretShaped } from '../../shared/secret-shaped.ts'
import { classify, FAILS_OVER, type FailureKind, isNonAnswer } from './failure/failure.ts'
import { decideOutcomeRule, type OutcomeInputs, type OutcomeRule } from './outcome.ts'
import { errorTail } from './run/run-process.ts'
import { failureKindFromStop, stopErrorMessage } from './transport/transport.ts'

export const LAST_VENDOR_EVENT_TYPE_MAX = 64
const CONTROL_CHARACTERS = /[\p{Cc}]/u

export type LiveOutcomeFacts = {
  writesJob: boolean
  contractStatus: 'done' | 'asking' | 'refused' | null
  replyError: string | null
  output: string
  replyFilePresent: boolean
  replyFileError: string | null
  transportName: string
  transportStatus: string
  transportStopReason: string | null
  transportError: string | null
  transportFailureKind: FailureKind | null
  collectedAsking: boolean
  acceptedQuestions: boolean
  idleKilled: boolean
  idleKillError: string | null
  outputCeilingReached: boolean
  outputCeilingStopReason: string | null
  timedOut: boolean
  stderr: string
  stdout: string
  exitCode: number
  signal: string | null
  sandbox: 'host' | 'srt'
  boundMs: number
  agentName: string
}

export type LiveOutcomeDerivation = {
  inputs: OutcomeInputs<FailureKind>
  error: string | null
}

type CalculatedOutcome = {
  inputs: OutcomeInputs<FailureKind>
  completedContractTerminal: string
  missingContractTerminal: string
  classifiedMissingContract: FailureKind
  defaultError: string
}

function calculateOutcome(facts: LiveOutcomeFacts): CalculatedOutcome {
  const completedReplyAtTimeout =
    facts.contractStatus === 'done' ||
    (!facts.writesJob && !facts.replyError && !!facts.output && !isNonAnswer(facts.output))
  const acpVendorStop =
    facts.transportName === 'acp' &&
    facts.transportStatus === 'failed' &&
    Boolean(facts.transportStopReason && facts.transportStopReason !== 'end_turn')
  const completedReply =
    completedReplyAtTimeout ||
    (facts.replyFilePresent &&
      !facts.replyFileError &&
      (facts.contractStatus === 'done' || !facts.writesJob))
  const acpFailureKind =
    facts.transportFailureKind ??
    failureKindFromStop(facts.transportStopReason, facts.transportError)
  const replyErrorFailureKind = classify(
    facts.replyError ?? '',
    facts.exitCode,
    facts.timedOut,
    facts.sandbox,
  )
  const nonAnswer = facts.exitCode === 0 && isNonAnswer(facts.output)
  const nonAnswerFailureKind = classify(facts.output, facts.exitCode, facts.timedOut, facts.sandbox)
  const completedContractTerminal = facts.stderr.trim() || facts.stdout.trim()
  const completedContractFailureKind = classify(
    completedContractTerminal,
    facts.exitCode,
    facts.timedOut,
    facts.sandbox,
  )
  const missingContractTerminal = facts.stderr.trim() || facts.output || facts.stdout.trim()
  const classifiedMissingContract = classify(
    missingContractTerminal,
    facts.exitCode,
    facts.timedOut,
    facts.sandbox,
  )
  const missingContractFailureKind = FAILS_OVER.includes(classifiedMissingContract)
    ? classifiedMissingContract
    : 'contract'
  const defaultError = errorTail(
    facts.stderr.trim() || facts.stdout.trim() || `exit ${facts.exitCode}, empty output`,
  )
  const defaultFailureKind = classify(defaultError, facts.exitCode, facts.timedOut, facts.sandbox)

  return {
    inputs: {
      idleKilled: facts.idleKilled,
      completedReply,
      collectedAsking: facts.collectedAsking,
      acceptedQuestions: facts.acceptedQuestions,
      acpVendorStop,
      acpFailureKind,
      replyFileError: Boolean(facts.replyFileError),
      replyFilePresent: facts.replyFilePresent,
      outputCeilingReached: facts.outputCeilingReached,
      timedOut: facts.timedOut,
      completedReplyAtTimeout,
      replyError: Boolean(facts.replyError),
      replyErrorFailureKind,
      nonAnswer,
      nonAnswerFailureKind,
      contractStatus: facts.contractStatus,
      exitCode: facts.exitCode,
      completedContractFailureKind,
      missingRequiredContract: facts.writesJob && facts.contractStatus === null,
      missingContractFailureKind,
      outputPresent: Boolean(facts.output),
      defaultFailureKind,
    },
    completedContractTerminal,
    missingContractTerminal,
    classifiedMissingContract,
    defaultError,
  }
}

export type CompletedReplyEndedFacts = {
  exitCode: number
  failoverTerminal: string
  signal: string | null
  lastVendorEventType: string | null
  lastVendorError?: string | null
  stderr: string
}

type LastStdoutJsonlEvent = {
  type: string
  error: string | null
}

/** Last stdout JSONL object, including a line the vendor parser ignored. */
function lastStdoutJsonlEvent(stdout: string): LastStdoutJsonlEvent | null {
  const line =
    stdout
      .split('\n')
      .findLast((candidate) => candidate.trim())
      ?.trim() ?? ''
  if (!line.startsWith('{')) return null
  try {
    const raw: unknown = JSON.parse(line)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const event = raw as { type?: unknown; message?: unknown; error?: unknown }
    if (typeof event.type !== 'string' || !event.type) return null
    const nestedError =
      event.error !== null && typeof event.error === 'object' && !Array.isArray(event.error)
        ? (event.error as { message?: unknown }).message
        : null
    const error =
      typeof nestedError === 'string'
        ? nestedError
        : typeof event.message === 'string'
          ? event.message
          : typeof event.error === 'string'
            ? event.error
            : null
    return { type: event.type, error }
  } catch {
    return null
  }
}

function recordedLastVendorEventType(raw: string | null): string | null {
  const trimmed = raw?.trim() ?? ''
  if (!trimmed || CONTROL_CHARACTERS.test(trimmed)) return null
  const redacted = redactSecretShaped(trimmed).text
  if (redacted.length <= LAST_VENDOR_EVENT_TYPE_MAX) return redacted
  return `${redacted.slice(0, LAST_VENDOR_EVENT_TYPE_MAX)}…`
}

export function composeCompletedReplyEndedError(facts: CompletedReplyEndedFacts): string {
  const notice =
    `the worker wrote a done-shaped reply, then the process ended ` +
    `(exit ${facts.exitCode}) before the run finished. ` +
    `Its work so far is in the worktree; read the diff and resume.`
  const head = facts.failoverTerminal ? `${facts.failoverTerminal}\n${notice}` : notice
  const lines = [errorTail(head)]
  const signal = facts.signal?.trim() ?? ''
  if (signal) lines.push(`signal: ${signal}`)
  const eventType = recordedLastVendorEventType(facts.lastVendorEventType)
  if (eventType) lines.push(`last vendor event: ${eventType}`)
  const vendorError = facts.lastVendorError?.trim() ?? ''
  if (vendorError) {
    const body = redactSecretShaped(vendorError).text
    lines.push(`vendor error: ${errorTail(body)}`)
  }
  const stderr = facts.stderr.trim()
  if (stderr) {
    const body = redactSecretShaped(stderr).text
    lines.push(`vendor stderr: ${errorTail(body)}`)
  }
  return lines.join('\n')
}

function withVendorStderrTail(facts: LiveOutcomeFacts, error: string | null): string | null {
  if (facts.exitCode === 0 || facts.stdout.trim()) return error
  const prefix = facts.stderr.trim() ? errorTail(facts.stderr) : ''
  if (!prefix) return error
  if (!error) return prefix
  if (error === prefix || error.startsWith(`${prefix}\n`) || error.startsWith(prefix)) return error
  return `${prefix}\n${error}`
}

function deriveError(facts: LiveOutcomeFacts, calculated: CalculatedOutcome): string | null {
  const { inputs } = calculated
  const completedReplyEndedError = () => {
    const lastVendorEvent = lastStdoutJsonlEvent(facts.stdout)
    return composeCompletedReplyEndedError({
      exitCode: facts.exitCode,
      failoverTerminal: FAILS_OVER.includes(inputs.completedContractFailureKind)
        ? calculated.completedContractTerminal
        : '',
      signal: facts.signal,
      lastVendorEventType: lastVendorEvent?.type ?? null,
      lastVendorError: lastVendorEvent?.error ?? null,
      stderr: facts.stderr,
    })
  }
  const rule = decideOutcomeRule(inputs)
  const messages: Record<OutcomeRule, () => string | null> = {
    'idle-completed': () => null,
    'idle-asking': () => null,
    idle: () => errorTail(facts.idleKillError ?? 'idle-killed with no CPU'),
    'acp-vendor-stop': () =>
      errorTail(facts.transportError ?? stopErrorMessage(facts.transportStopReason!)),
    'reply-file-mismatch': () => errorTail(facts.replyFileError!),
    asking: () => null,
    truncated: () => `response truncated at output ceiling (${facts.outputCeilingStopReason})`,
    'timeout-completed': () => null,
    timeout: () =>
      `no reply within ${Math.round(facts.boundMs / 60_000)}m; ${facts.agentName} was killed`,
    'reply-error': () => errorTail(facts.replyError!),
    'non-answer': () => errorTail(facts.output),
    'missing-reply-contract': () => errorTail(facts.replyFileError!),
    'contract-asking': () => null,
    refused: () => null,
    'completed-then-ended': completedReplyEndedError,
    'missing-writer-contract': () =>
      FAILS_OVER.includes(calculated.classifiedMissingContract)
        ? errorTail(calculated.missingContractTerminal)
        : errorTail(`reply did not match the worker contract:\n${facts.output}`),
    default: () => (facts.exitCode === 0 && facts.output ? null : calculated.defaultError),
  }
  const error = messages[rule]()
  if (rule === 'completed-then-ended') return error
  return withVendorStderrTail(facts, error)
}

/** Derive the live process outcome inputs without applying the decision or any effects. */
export function deriveLiveOutcome(facts: LiveOutcomeFacts): LiveOutcomeDerivation {
  const calculated = calculateOutcome(facts)
  return { inputs: calculated.inputs, error: deriveError(facts, calculated) }
}
