// concern: question inbox counts
/** Reads the shared inbox classification and counts it for one viewing session. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import type { QuestionInboxGroup } from './question-inbox-group.ts'
import { queryInbox } from './run-inbox.ts'

export type QuestionInboxCounts = Record<QuestionInboxGroup, number>

export async function questionInboxCountsForSession(
  session: string,
  database: Database = db(),
): Promise<QuestionInboxCounts | null> {
  try {
    const result = await queryInbox(
      { scope: 'cli-default', all: true, activeOnly: true },
      database,
      session,
    )
    const counts: QuestionInboxCounts = { worker: 0, user: 0, foreign: 0, unowned: 0 }
    for (const question of result.questions) counts[question.group] += 1
    return counts
  } catch {
    return null
  }
}
