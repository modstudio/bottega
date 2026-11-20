// concern: run-terminal-questions
/** Records reply-borne questions only while their local owner turn is live. */

import { writeFileSync } from 'node:fs'
import { recordReplyQuestions } from '../ask/ask.ts'
import type { realQuestions } from '../contract/contract.ts'
import { db, nowIso } from '../database/db.ts'
import { initialQuestionWaitingAt } from '../operator/operator-waiting.ts'
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

async function recordTerminalQuestions(
  runId: string,
  questions: ReturnType<typeof realQuestions>,
  currentHeader: string | null,
): Promise<{
  recorded: Awaited<ReturnType<typeof recordReplyQuestions>>
  operationalHeader: string | null
}> {
  if (!questions.length) return { recorded: [], operationalHeader: currentHeader }
  const owner = db()
    .query<{ status: string }, [string]>('SELECT status FROM run WHERE record_id=?')
    .get(runId)
  // Reply asks: is this turn still the live owner of its escalation channel?
  if (!owner || (owner.status !== 'running' && owner.status !== 'asking')) {
    const count = questions.length
    const dropped = `Dropped ${count} reply question${count === 1 ? '' : 's'} because run ${runId} was already superseded or finished.`
    return {
      recorded: [],
      operationalHeader: currentHeader ? `${currentHeader}\n${dropped}` : dropped,
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
    operationalHeader: currentHeader,
  }
}

export async function finishQs(
  runId: string,
  questions: ReturnType<typeof realQuestions>,
  currentHeader: string | null,
  output: string,
  outPath: string,
): Promise<{ recorded: Awaited<ReturnType<typeof recordReplyQuestions>>; output: string }> {
  const result = await recordTerminalQuestions(runId, questions, currentHeader)
  const finalizedOutput = result.operationalHeader
    ? output
      ? `${result.operationalHeader}\n\n${output}`
      : result.operationalHeader
    : output
  if (result.operationalHeader) writeFileSync(outPath, finalizedOutput)
  return { recorded: result.recorded, output: finalizedOutput }
}
