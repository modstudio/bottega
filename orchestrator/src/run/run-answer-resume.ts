// concern: answered run resume
/** Selects and reports the resumed turn created after durable rulings. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { AnswerWaitingResult } from '../../../shared/orch-contract.ts'
import { db } from '../database/db.ts'
import { failureReason } from '../outcome.ts'
import { harnessContinuationWorker } from './run-harness-continuation.ts'
import { follow, type RunControlPresentation, reportHarnessHandoff } from './run-control.ts'

export function answerResumeWorker(
  executor: 'external' | 'harness',
  resumeAgent: string,
  vendorSession: string,
) {
  return harnessContinuationWorker(executor) ?? { agent: resumeAgent, session: vendorSession }
}

export function answerResumeUnavailable(input: {
  ownersLive: boolean
  skipResume: boolean
  executor: 'external' | 'harness'
  vendorSession: string | null | undefined
  resumable: boolean | undefined
}): boolean {
  return (
    !input.ownersLive &&
    !input.skipResume &&
    input.executor !== 'harness' &&
    (!input.vendorSession || input.resumable === false)
  )
}

function result(rootId: string, rootNumber: number, childId: string): AnswerWaitingResult {
  const childNumber = db()
    .query<{ number: number }, [string]>('SELECT number FROM run WHERE record_id=?')
    .get(childId)?.number
  return {
    outcome: 'resumed',
    run_record_id: rootId,
    run_number: rootNumber,
    resumed_record_id: childId,
    resumed_number: childNumber ?? null,
  }
}

export async function reportAnswerResume(input: {
  rootId: string
  rootNumber: number
  childId: string
  job: string
  answerCount: number
  json: boolean
  flags: { detach: boolean; follow: boolean; quiet: boolean }
  presentation: RunControlPresentation
}): Promise<AnswerWaitingResult> {
  if (!input.json)
    console.log(
      `ruled on ${input.answerCount} question(s); resumed run ${input.rootId} as run ${input.childId}`,
    )
  if (reportHarnessHandoff(input.childId))
    return result(input.rootId, input.rootNumber, input.childId)
  if (input.flags.detach || !input.flags.follow) {
    if (!input.flags.quiet)
      console.error(
        `\n— ${input.job} runs detached; a foreground one dies with its shell.` +
          `\n  ${PLATFORM_SLUG} run wait ${input.childId}      then:  ${PLATFORM_SLUG} run result ${input.childId}` +
          `\n  ${PLATFORM_SLUG} question inbox          if it stops to ask` +
          `\n  --follow            to watch it here instead`,
      )
    return result(input.rootId, input.rootNumber, input.childId)
  }
  const resumed = await follow(input.childId, input.flags.quiet, false, input.presentation)
  if (resumed !== 'ok' && resumed !== 'asking') {
    const failed = db()
      .query(`SELECT status, error, failure_kind, exit_code FROM run WHERE record_id=?`)
      .get(input.childId) as Parameters<typeof failureReason>[0]
    throw new Error(
      `the rulings ARE recorded and were not lost, but resumed run ${input.childId} failed: ` +
        `${failureReason(failed)}\nRetry it with: ${PLATFORM_SLUG} run continue ${input.rootId}`,
    )
  }
  const done = db().query('SELECT status FROM run WHERE record_id=?').get(input.rootId) as {
    status: string
  }
  console.error(
    done.status === 'asking'
      ? `\n  STILL ASKING — ${PLATFORM_SLUG} question inbox`
      : `\n  ${PLATFORM_SLUG} run diff ${input.rootId}    then score it: ${input.presentation.scoreHint(input.rootId, input.job, null)}`,
  )
  return result(input.rootId, input.rootNumber, input.childId)
}
