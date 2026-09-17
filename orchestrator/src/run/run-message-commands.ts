// concern: run-control
/** Owns answer, retry, and continuation command behavior. Must not know CLI grammar. */
import { AGENTS } from '../agent/agent-registry.ts'
import { resumePromptByteLimit } from '../agent/agents.ts'
import {
  assertWorkerText,
  CONTINUE_WORKING_FORMS,
  parseWorkerMessageArgs,
  readMessageText,
  readWorkerFile,
} from '../args.ts'
import { db } from '../db.ts'
import { JOBS } from '../jobs.ts'
import {
  REVIEW_COVERAGE,
  REVIEW_LIMITS,
  REVIEW_OVERLAP,
  REVIEW_REPRODUCED,
} from '../review-vocabulary.ts'
import { answerRun, retryRun } from './run-answer.ts'
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
const helpers = (presentation: Presentation) => ({
  argvResumeLimit,
  assertWorkerText,
  readWorkerFile,
  readMessageText,
  presentation: controlPresentation(presentation),
})

export async function retryCommand(
  id: number,
  options: { agent?: string; model?: string; flags: Flags },
  presentation: Presentation,
): Promise<void> {
  await retryRun(id, options, helpers(presentation))
}

export async function answerCommand(
  id: number,
  argv: string[],
  recordOnly: boolean,
  flags: Flags,
  presentation: Presentation,
): Promise<void> {
  await answerRun(id, { argv, recordOnly, flags }, helpers(presentation))
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
