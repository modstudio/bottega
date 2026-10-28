// concern: run-control
/** Owns answer, retry, and continuation command behavior. Must not know CLI grammar. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { AGENTS } from '../agent/agent-registry.ts'
import { resumePromptByteLimit } from '../agent/agents.ts'
import {
  ANSWER_WORKING_FORMS,
  assertWorkerText,
  CONTINUE_WORKING_FORMS,
  type ContinueArgs,
  parseAnswerChannelArgs,
  parseAnswerTextSources,
  questionOperatorFlag,
  readMessageText,
  readWorkerFile,
} from '../cli/args.ts'
import { db } from '../database/db.ts'
import { newestTurnOutputPath } from '../evidence/evidence-query.ts'
import { jobTakesFidelity } from '../jobs/job-fidelity.ts'
import { JOBS } from '../jobs/jobs.ts'
import {
  REVIEW_COVERAGE,
  REVIEW_LIMITS,
  REVIEW_OVERLAP,
  REVIEW_REPRODUCED,
} from '../review/review-vocabulary.ts'
import { refusalScoreGuidanceFromPath } from '../score/refusal-guidance.ts'
import { parseQuestionIdentifier, resolveQuestionIdentifier } from './question-identifier.ts'
import { questionOpenSql } from './question-open.ts'
import { rulingAttributionDecision } from './question-vocabulary.ts'
import { rulingFileOfferLines } from './ruling-file-text.ts'
import { type AnswerRunInput, answerRun, retryRun } from './run-answer.ts'
import { continueRun, type RunControlPresentation, reportContinuedRun } from './run-control.ts'

type Flags = { detach: boolean; follow: boolean; quiet: boolean }
type Presentation = { printRunId(id: string): void }
export type ContinueCommandDependencies = {
  continueRun: typeof continueRun
  reportContinuedRun: typeof reportContinuedRun
}

const continueCommandDependencies: ContinueCommandDependencies = { continueRun, reportContinuedRun }

const duration = (ms: number | null | undefined): string => {
  if (ms == null) return '—'
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
const scoreSuffix = (jobName: string) =>
  (jobTakesFidelity(jobName) ? ' [drifted|partial|faithful]' : '') +
  (JOBS[jobName]?.findings
    ? ` [--reproduced ${REVIEW_REPRODUCED.join('|')}] [--coverage ${REVIEW_COVERAGE.join('|')}] [--limits ${REVIEW_LIMITS.join('|')}] [--overlap ${REVIEW_OVERLAP.join('|')}]`
    : '')
const scoreHint = (id: string, jobName: string, parent: string | null) => {
  const refusal = refusalScoreGuidanceFromPath(newestTurnOutputPath(db(), parent ?? id), jobName)
  return (
    `${PLATFORM_SLUG} score ${parent ?? id} <none|partial|full> [wrong|mixed|right]${scoreSuffix(jobName)} --note "..."` +
    (parent ? `   # the whole conversation, not turn ${id}` : '') +
    (refusal ? `\n  ${refusal}` : '')
  )
}
const argvResumeLimit = (agentName: string) =>
  AGENTS[agentName]?.resumeArgv ? resumePromptByteLimit(AGENTS[agentName]!) : undefined
const controlPresentation = (presentation: Presentation): RunControlPresentation => ({
  dur: duration,
  scoreHint,
  argvResumeLimit,
  printRunId: presentation.printRunId,
})
export const answerRunHelpers = (presentation: Presentation) => ({
  argvResumeLimit,
  assertWorkerText,
  readWorkerFile,
  readMessageText,
  presentation: controlPresentation(presentation),
})

export async function answerInputFromArgv(
  argv: string[],
  recordOnly: boolean,
  json: boolean,
  flags: Flags,
  helpers: Pick<ReturnType<typeof answerRunHelpers>, 'readWorkerFile' | 'readMessageText'>,
  refusedOptions?: Readonly<Record<string, string>>,
): Promise<AnswerRunInput> {
  const channelArgs = parseAnswerChannelArgs(argv)
  const parsed = parseAnswerTextSources(channelArgs.argv, refusedOptions)
  const fromOperator = channelArgs.argv.includes('--from-operator')
  const operatorQuestionIds = (parsed.fromOperatorIds ?? []).map((identifier) => ({
    identifier,
    questionId: resolveQuestionIdentifier(db(), identifier),
  }))
  let rulings: AnswerRunInput['rulings']
  let allowPartialRecordOnly = false
  const cliRuling = (text: string) => {
    if (text) assertWorkerText(text, 'ruling', ANSWER_WORKING_FORMS)
    return text
  }
  if (parsed.byId.length) {
    if (parsed.commandFile !== undefined || parsed.positionals.length) {
      throw new Error(
        'pass --file next to each --q<id>, not as a command-level flag or positional alongside --q\n' +
          `working forms:\n${ANSWER_WORKING_FORMS}`,
      )
    }
    rulings = parsed.byId.map((source) => {
      const parsedIdentifier = parseQuestionIdentifier(source.identifier)
      if (parsedIdentifier.kind === 'record-id') allowPartialRecordOnly = true
      const questionId = resolveQuestionIdentifier(db(), source.identifier)
      const perQuestion = operatorQuestionIds.some(
        (operatorQuestion) => operatorQuestion.questionId === questionId,
      )
      const attribution = rulingAttributionDecision(fromOperator, perQuestion)
      if (attribution.kind === 'conflict') {
        throw new Error(
          `--from-operator cannot be combined with ${questionOperatorFlag(source.identifier)}; use --from-operator for every ruling or ${questionOperatorFlag('<id>')} for individual rulings`,
        )
      }
      return {
        questionId,
        text: cliRuling(
          source.file !== undefined ? helpers.readWorkerFile(source.file) : source.text!,
        ),
        fromOperator: attribution.kind === 'operator',
      }
    })
  } else if (
    parsed.commandFile !== undefined ||
    (!parsed.positionals.length && !process.stdin.isTTY)
  ) {
    rulings = cliRuling(
      (await helpers.readMessageText({
        missing: 'no ruling: pass it as an argument, via --file, or on stdin',
        exclusive: 'pass the ruling either positionally or with --file, not both',
        sources: parsed,
      })) ?? '',
    )
  } else {
    rulings = cliRuling(parsed.positionals.join(' '))
  }
  const ruledQuestionIds = new Set(
    Array.isArray(rulings) ? rulings.map((ruling) => ruling.questionId) : [],
  )
  const unattached = operatorQuestionIds.filter(
    ({ questionId }) => !ruledQuestionIds.has(questionId),
  )
  if (unattached.length) {
    throw new Error(
      `${unattached.map(({ identifier }) => questionOperatorFlag(identifier)).join(', ')} must accompany the matching --q<id> ruling\n` +
        `nothing was stored\nworking forms:\n${ANSWER_WORKING_FORMS}`,
    )
  }
  return {
    rulings,
    allowPartialRecordOnly,
    fromOperator: Array.isArray(rulings) ? false : fromOperator,
    channel: channelArgs.channel,
    recordOnly,
    json,
    flags,
  }
}

export async function retryCommand(
  id: string,
  options: { agent?: string; model?: string; flags: Flags },
  presentation: Presentation,
): Promise<void> {
  await retryRun(id, options, answerRunHelpers(presentation))
}

function answeredQuestions(
  runId: string,
  input: AnswerRunInput,
): { number: number; fromOperator: boolean }[] {
  const { rulings } = input
  if (typeof rulings !== 'string') {
    const number = db().query<{ number: number }, [string]>(
      'SELECT number FROM question WHERE record_id=?',
    )
    return rulings.map((ruling) => ({
      number: number.get(ruling.questionId)!.number,
      fromOperator: ruling.fromOperator,
    }))
  }
  return (
    db()
      .query(
        `SELECT q.number FROM question q JOIN run owner ON owner.record_id=q.run_record_id
          WHERE (owner.record_id=? OR owner.parent_run_record_id=?) AND ${questionOpenSql('q')}
          ORDER BY q.number`,
      )
      .all(runId, runId) as { number: number }[]
  ).map((row) => ({ number: row.number, fromOperator: input.fromOperator }))
}

export async function answerCommand(
  id: string,
  argv: string[],
  recordOnly: boolean,
  json: boolean,
  flags: Flags,
  presentation: Presentation,
  refusedOptions?: Readonly<Record<string, string>>,
): Promise<void> {
  const helpers = answerRunHelpers(presentation)
  const input = await answerInputFromArgv(argv, recordOnly, json, flags, helpers, refusedOptions)
  const questions = answeredQuestions(id, input)
  const result = await answerRun(id, input, helpers)
  if (json) console.log(JSON.stringify(result))
  else {
    for (const line of rulingFileOfferLines({
      questionIds: questions
        .filter((question) => question.fromOperator)
        .map((question) => question.number),
      operatorAttributed: true,
      json: false,
    })) {
      console.log(line)
    }
  }
}

export async function continueCommand(
  id: string,
  parsed: ContinueArgs,
  includeFindings: boolean,
  flags: Flags,
  presentation: Presentation,
  renderFindings: (runId: string, message: string | undefined) => string,
  dependencies: ContinueCommandDependencies = continueCommandDependencies,
): Promise<void> {
  const chain = db()
    .query('SELECT record_id, agent, parent_run_record_id FROM run WHERE record_id = ?')
    .get(id) as {
    record_id: string
    agent: string
    parent_run_record_id: string | null
  } | null
  const message = await readMessageText({
    missing: 'no message: pass it as an argument, via --file, or on stdin',
    exclusive: 'pass the message either positionally or with --file, not both',
    sources: parsed.sources,
  })
  assertWorkerText(
    message!,
    'message',
    CONTINUE_WORKING_FORMS,
    chain ? argvResumeLimit(chain.agent) : undefined,
  )
  const resumed = await dependencies.continueRun(
    id,
    message,
    argvResumeLimit,
    includeFindings ? () => renderFindings(id, message) : undefined,
  )
  await dependencies.reportContinuedRun(
    resumed.childId,
    resumed.job,
    flags,
    controlPresentation(presentation),
  )
}
