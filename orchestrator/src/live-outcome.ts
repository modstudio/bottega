// concern: live-outcome
import { classify, FAILS_OVER, type FailureKind, isNonAnswer } from './failure/failure.ts'
import type { OutcomeInputs } from './outcome.ts'
import { errorTail } from './run/run-process.ts'
import { failureKindFromStop, stopErrorMessage } from './transport/transport.ts'

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
    : 'other'
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
  const rules: Array<[boolean, () => string | null]> = [
    [facts.idleKilled && inputs.completedReply, () => null],
    [facts.idleKilled && (facts.collectedAsking || facts.acceptedQuestions), () => null],
    [facts.idleKilled, () => errorTail(facts.idleKillError ?? 'idle-killed with no CPU')],
    [
      inputs.acpVendorStop,
      () => errorTail(facts.transportError ?? stopErrorMessage(facts.transportStopReason!)),
    ],
    [Boolean(facts.replyFileError), () => errorTail(facts.replyFileError!)],
    [facts.collectedAsking || facts.acceptedQuestions, () => null],
    [
      facts.outputCeilingReached,
      () => `response truncated at output ceiling (${facts.outputCeilingStopReason})`,
    ],
    [facts.timedOut && inputs.completedReplyAtTimeout, () => null],
    [
      facts.timedOut,
      () => `no reply within ${Math.round(facts.boundMs / 60_000)}m; ${facts.agentName} was killed`,
    ],
    [Boolean(facts.replyError), () => errorTail(facts.replyError!)],
    [inputs.nonAnswer, () => errorTail(facts.output)],
    [facts.contractStatus === 'refused', () => null],
    [
      facts.exitCode !== 0 && facts.contractStatus === 'done',
      () =>
        errorTail(
          (FAILS_OVER.includes(inputs.completedContractFailureKind)
            ? `${calculated.completedContractTerminal}\n`
            : '') +
            `the worker completed and wrote its reply, then the process ended ` +
            `(exit ${facts.exitCode}). Its work is in the worktree; resume or read the diff.`,
        ),
    ],
    [
      inputs.missingRequiredContract,
      () =>
        FAILS_OVER.includes(calculated.classifiedMissingContract)
          ? errorTail(calculated.missingContractTerminal)
          : errorTail(`reply did not match the worker contract:\n${facts.output}`),
    ],
  ]
  const matched = rules.find(([applies]) => applies)
  const error = matched
    ? matched[1]()
    : facts.exitCode === 0 && facts.output
      ? null
      : calculated.defaultError
  return withVendorStderrTail(facts, error)
}

/** Derive the live process outcome inputs without applying the decision or any effects. */
export function deriveLiveOutcome(facts: LiveOutcomeFacts): LiveOutcomeDerivation {
  const calculated = calculateOutcome(facts)
  return { inputs: calculated.inputs, error: deriveError(facts, calculated) }
}
