// concern: run-terminal-questions
/** Records reply-borne questions only while their local owner turn is live. */

import type { realQuestions } from '../contract/contract.ts'
import { db, nowIso } from '../database/db.ts'
import { initialQuestionWaitingAt } from '../operator/operator-waiting.ts'
import { recordReplyQuestions } from '../ask/ask.ts'
import { questionsForRun } from '../question-store/question-store-read.ts'

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

export async function recordRunTerminalQuestions(
  runId: string,
  questions: ReturnType<typeof realQuestions>,
): Promise<{
  recorded: Awaited<ReturnType<typeof recordReplyQuestions>>
  operationalHeader: string | null
}> {
  if (!questions.length) return { recorded: [], operationalHeader: null }
  const owner = db()
    .query<{ status: string }, [string]>('SELECT status FROM run WHERE record_id=?')
    .get(runId)
  // Reply asks: is this turn still the live owner of its escalation channel?
  if (!owner || (owner.status !== 'running' && owner.status !== 'asking')) {
    const count = questions.length
    return {
      recorded: [],
      operationalHeader: `Dropped ${count} reply question${count === 1 ? '' : 's'} because run ${runId} was already superseded or finished.`,
    }
  }
  const existingQuestionTexts = (await questionsForRun(db(), runId)).map((row) =>
    String(row.question),
  )
  const askedAt = nowIso()
  return {
    recorded: await recordReplyQuestions({
      runId,
      questions: questionsToInsert(existingQuestionTexts, questions),
      askedAt,
      awaitingOperatorAt: await initialQuestionWaitingAt(runId, askedAt),
    }),
    operationalHeader: null,
  }
}
