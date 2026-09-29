// concern: run-control
/** Owns answer, retry, and continuation command behavior. Must not know CLI grammar. */
import { AGENTS } from '../agent/agent-registry.ts'
import { resumePromptByteLimit } from '../agent/agents.ts'
import {
  ANSWER_WORKING_FORMS,
  assertWorkerText,
  CONTINUE_WORKING_FORMS,
  parseAnswerChannelArgs,
  parseAnswerTextSources,
  parseWorkerMessageArgs,
  readMessageText,
  readWorkerFile,
} from '../cli/args.ts'
import { db } from '../database/db.ts'
import { JOBS } from '../jobs/jobs.ts'
import {
  REVIEW_COVERAGE,
  REVIEW_LIMITS,
  REVIEW_OVERLAP,
  REVIEW_REPRODUCED,
} from '../review/review-vocabulary.ts'
import { questionOpenSql } from './question-open.ts'
import { operatorAttributedRuling, rulingFileOfferLines } from './ruling-file-text.ts'
import { type AnswerRunInput, answerRun, retryRun } from './run-answer.ts'
import { continueRun, type RunControlPresentation, reportContinuedRun } from './run-control.ts'

type Flags = { detach: boolean; follow: boolean; quiet: boolean }
type Presentation = { printRunId(id: number): void }

const duration = (ms: number | null | undefined): string => {
  if (ms == null) return '—'
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
const scoreSuffix = (jobName: string) =>
  (JOBS[jobName]?.needs.writesRepo ? ' [drifted|partial|faithful]' : '') +
  (JOBS[jobName]?.findings
    ? ` [--reproduced ${REVIEW_REPRODUCED.join('|')}] [--coverage ${REVIEW_COVERAGE.join('|')}] [--limits ${REVIEW_LIMITS.join('|')}] [--overlap ${REVIEW_OVERLAP.join('|')}]`
    : '')
const scoreHint = (id: number, jobName: string, parent: number | null) =>
  `orch score ${parent ?? id} <none|partial|full> [wrong|mixed|right]${scoreSuffix(jobName)} --note "..."${parent ? `   # the whole conversation, not turn ${id}` : ''}`
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
): Promise<AnswerRunInput> {
  const channelArgs = parseAnswerChannelArgs(argv)
  const parsed = parseAnswerTextSources(channelArgs.argv)
  let rulings: AnswerRunInput['rulings']
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
    rulings = parsed.byId.map((source) => ({
      questionId: source.id,
      text: cliRuling(
        source.file !== undefined ? helpers.readWorkerFile(source.file) : source.text!,
      ),
    }))
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
  return {
    rulings,
    fromOperator: channelArgs.argv.includes('--from-operator'),
    channel: channelArgs.channel,
    recordOnly,
    json,
    flags,
  }
}

export async function retryCommand(
  id: number,
  options: { agent?: string; model?: string; flags: Flags },
  presentation: Presentation,
): Promise<void> {
  await retryRun(id, options, answerRunHelpers(presentation))
}

function answeredQuestionIds(runId: number, rulings: AnswerRunInput['rulings']): number[] {
  if (typeof rulings !== 'string') return rulings.map((ruling) => ruling.questionId)
  return (
    db()
      .query(
        `SELECT q.id FROM question q JOIN run owner ON owner.id=q.run_id
          WHERE (owner.id=? OR owner.parent_run_id=?) AND ${questionOpenSql('q')}
          ORDER BY q.id`,
      )
      .all(runId, runId) as { id: number }[]
  ).map((row) => row.id)
}

export async function answerCommand(
  id: number,
  argv: string[],
  recordOnly: boolean,
  json: boolean,
  flags: Flags,
  presentation: Presentation,
): Promise<void> {
  const helpers = answerRunHelpers(presentation)
  const input = await answerInputFromArgv(argv, recordOnly, json, flags, helpers)
  const questionIds = answeredQuestionIds(id, input.rulings)
  const result = await answerRun(id, input, helpers)
  if (json) console.log(JSON.stringify(result))
  else {
    for (const line of rulingFileOfferLines({
      questionIds,
      operatorAttributed: operatorAttributedRuling({
        fromOperator: input.fromOperator,
        channel: input.channel,
      }),
      json: false,
    })) {
      console.log(line)
    }
  }
}

export async function continueCommand(
  id: number,
  argv: string[],
  flags: Flags,
  presentation: Presentation,
): Promise<void> {
  const chain = db().query('SELECT id, agent, parent_run_id FROM run WHERE id = ?').get(id) as {
    id: number
    agent: string
    parent_run_id: number | null
  } | null
  const sources = parseWorkerMessageArgs(argv, {
    booleans: ['--follow', '--detach', '--quiet'],
    usage: 'orch continue <id> ["<what next>"] [--file PATH] [--follow]',
  })
  const message = await readMessageText({
    missing: 'no message: pass it as an argument, via --file, or on stdin',
    exclusive: 'pass the message either positionally or with --file, not both',
    optional: true,
    sources,
  })
  if (message !== undefined)
    assertWorkerText(
      message,
      'message',
      CONTINUE_WORKING_FORMS,
      chain ? argvResumeLimit(chain.agent) : undefined,
    )
  const resumed = await continueRun(id, message, argvResumeLimit)
  await reportContinuedRun(resumed.childId, resumed.job, flags, controlPresentation(presentation))
}
