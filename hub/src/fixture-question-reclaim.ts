// concern: fixture-question-reclaim
/** One-time removal of question and interval rows leaked by the named gate fixtures. */
import { db, writeTransaction } from './db.ts'
import { readRunsById } from './orch.ts'
import { indexRunAnswers, runRef } from './reconcile.ts'

const FIXTURE_SESSIONS = new Set(['sess-a', 'sess-b', 'sess-old', 'sess-probe'])
const FIXTURE_INTERVAL_REFS = new Set([
  'orch:9103',
  'orch:9105',
  'orch:9108',
  'orch:9201',
  'orch:9401',
  'orch:9901',
  'orch:10001',
  'orch:9301:turn:9302',
])

export type FixtureQuestion = {
  question_id: number
  run_ref: string
  root_ref: string
  task_key: string | null
  session_id: string | null
}

export type FixtureInterval = {
  id: number
  source: string
  ref: string
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

export function fixtureIntervalsWithoutRuns(
  intervals: FixtureInterval[],
  answersById: ReadonlyMap<number, unknown>,
): FixtureInterval[] {
  return intervals.filter((interval) => {
    if (interval.source !== 'orch') return false
    if (!FIXTURE_INTERVAL_REFS.has(interval.ref)) return false
    const parsed = runRef(interval.ref)
    if (!parsed) return false
    const answer = answersById.get(parsed.turn ?? parsed.root)
    return answer == null || (typeof answer === 'object' && answer !== null && 'unknown' in answer)
  })
}

export async function reclaimFixtureQuestions(
  dryRun: boolean,
): Promise<{ rows: FixtureQuestion[]; intervals: FixtureInterval[] }> {
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
  const intervals = database
    .query('SELECT id, source, ref FROM interval ORDER BY id')
    .all() as FixtureInterval[]
  const listed = intervals.filter(
    (interval) => interval.source === 'orch' && FIXTURE_INTERVAL_REFS.has(interval.ref),
  )
  const runIds = [
    ...new Set(
      listed.flatMap((interval) => {
        const parsed = runRef(interval.ref)
        return parsed ? [parsed.turn ?? parsed.root] : []
      }),
    ),
  ]
  const answers = await readRunsById(runIds)
  const selectedIntervals = fixtureIntervalsWithoutRuns(listed, indexRunAnswers(answers))
  if (!dryRun && (selected.length || selectedIntervals.length)) {
    writeTransaction((connection) => {
      const removeQuestion = connection.query('DELETE FROM question WHERE question_id=?')
      for (const row of selected) removeQuestion.run(row.question_id)
      const removeInterval = connection.query('DELETE FROM interval WHERE id=?')
      for (const interval of selectedIntervals) removeInterval.run(interval.id)
    })
  }
  return { rows: selected, intervals: selectedIntervals }
}
