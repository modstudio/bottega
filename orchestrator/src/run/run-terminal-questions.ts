// concern: run-terminal-questions
/** Records reply-borne questions only while their local owner turn is live. */

import { recordReplyQuestions } from '../ask/ask.ts'
import type { realQuestions } from '../contract/contract.ts'
import { db, nowIso } from '../database/db.ts'
import { initialQuestionWaitingAt } from '../operator/operator-waiting.ts'
import { questionsForRun } from '../question-store/question-store-read.ts'
import {
  isRunQuestionOwnerNotLive,
  runQuestionOwnerLive,
} from '../question-store/run-question-write-guard.ts'

/** Which accepted questions have not already been recorded, preserving reply order. */
export function questionsToInsert<T extends { question: string }>(
  existingQuestionTexts: string[],
  acceptedQuestions: T[],
): T[] {
  const norm = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase()
  const already = new Set(existingQuestionTexts.map(norm))
  return acceptedQuestions.filter((item) => {
    const question = norm(item.question)
    if (already.has(question)) return false
    already.add(question)
    return true
  })
}

export async function recordTerminalQuestions(
  runId: string,
  questions: ReturnType<typeof realQuestions>,
): Promise<{
  recorded: Awaited<ReturnType<typeof recordReplyQuestions>>
  notice: string | null
}> {
  if (!questions.length) return { recorded: [], notice: null }
  const owner = db()
    .query<{ status: string }, [string]>('SELECT status FROM run WHERE record_id=?')
    .get(runId)
  // Reply asks: is this turn still the live owner of its escalation channel?
  if (!runQuestionOwnerLive(owner?.status)) {
    const count = questions.length
    return {
      recorded: [],
      notice: `Dropped ${count} reply question${count === 1 ? '' : 's'} because run ${runId} was already superseded or finished.`,
    }
  }
  const existingQuestionTexts = (await questionsForRun(db(), runId)).map((row) =>
    String(row.question),
  )
  const askedAt = nowIso()
  try {
    return {
      recorded: await recordReplyQuestions({
        runId,
        questions: questionsToInsert(existingQuestionTexts, questions),
        askedAt,
        awaitingOperatorAt: await initialQuestionWaitingAt(runId, askedAt),
      }),
      notice: null,
    }
  } catch (error) {
    if (!isRunQuestionOwnerNotLive(error)) throw error
    const count = questions.length
    return {
      recorded: [],
      notice: `Dropped ${count} reply question${count === 1 ? '' : 's'} because the record refused the write after run ${runId} was superseded or finished.`,
    }
  }
}
