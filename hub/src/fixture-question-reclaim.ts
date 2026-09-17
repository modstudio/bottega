// concern: fixture-question-reclaim
/** One-time removal of question rows leaked by the named gate fixtures. */
import { db, writeTransaction } from './db.ts'

const FIXTURE_SESSIONS = new Set(['sess-a', 'sess-b', 'sess-old', 'sess-probe'])

export type FixtureQuestion = {
  question_id: number
  run_ref: string
  root_ref: string
  task_key: string | null
  session_id: string | null
}

export function fixtureQuestionsWithoutRuns(
  questions: FixtureQuestion[],
  runRefs: ReadonlySet<string>,
): FixtureQuestion[] {
  return questions.filter(
    (row) =>
      row.session_id !== null &&
      FIXTURE_SESSIONS.has(row.session_id) &&
      !runRefs.has(row.run_ref) &&
      !runRefs.has(row.root_ref),
  )
}

export function reclaimFixtureQuestions(dryRun: boolean): FixtureQuestion[] {
  const database = db()
  const questions = database
    .query(
      'SELECT question_id,run_ref,root_ref,task_key,session_id FROM question ORDER BY question_id',
    )
    .all() as FixtureQuestion[]
  const refs = new Set(
    (database.query("SELECT ref FROM interval WHERE source='orch'").all() as { ref: string }[]).map(
      (row) => row.ref,
    ),
  )
  const selected = fixtureQuestionsWithoutRuns(questions, refs)
  if (!dryRun && selected.length) {
    writeTransaction((connection) => {
      const remove = connection.query('DELETE FROM question WHERE question_id=?')
      for (const row of selected) remove.run(row.question_id)
    })
  }
  return selected
}
