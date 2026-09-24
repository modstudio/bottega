// concern: fixture-question-reclaim
/** One-time removal of question, interval and task rows leaked by the named gate fixtures. */
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
const FIXTURE_TASKS = [
  { key: 'ALP-899', project: 'alpha', title: 'No assignment field' },
  { key: 'ALP-900', project: 'alpha', title: 'seed' },
  { key: 'ALP-997', project: 'alpha', title: 'Awaiting Oracle' },
  { key: 'ALP-998', project: 'alpha', title: 'Vendor Mystery' },
  { key: 'BET-700', project: 'beta', title: 'seed' },
  { key: 'LOC-638', project: 'workshop', title: 'Ticketed report work' },
] as const

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

export type FixtureTask = {
  key: string
  project: string
  title: string | null
  opened_at: string | null
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
    return typeof answer === 'object' && answer !== null && 'unknown' in answer
  })
}

export function fixtureTasksToReclaim(
  rows: FixtureTask[],
  registeredProjects: ReadonlySet<string>,
): FixtureTask[] {
  return rows.filter(
    (row) =>
      row.opened_at === null &&
      !registeredProjects.has(row.project) &&
      FIXTURE_TASKS.some(
        (fixture) =>
          fixture.key === row.key && fixture.project === row.project && fixture.title === row.title,
      ),
  )
}

export async function reclaimFixtureQuestions(
  dryRun: boolean,
  registeredProjects: ReadonlySet<string>,
): Promise<{ rows: FixtureQuestion[]; intervals: FixtureInterval[]; tasks: FixtureTask[] }> {
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
  const answersById = indexRunAnswers(answers)
  const missingRunIds = runIds.filter((id) => !answersById.has(id))
  if (missingRunIds.length) {
    throw new Error(
      `orch's answer was incomplete; missing run ids: ${missingRunIds.join(', ')}; nothing was removed`,
    )
  }
  const selectedIntervals = fixtureIntervalsWithoutRuns(listed, answersById)
  for (const interval of selectedIntervals) refs.delete(interval.ref)
  const selected = fixtureQuestionsWithoutRuns(questions, refs)
  if (dryRun) {
    const tasks = database
      .query('SELECT key, project, title, opened_at FROM task ORDER BY key')
      .all() as FixtureTask[]
    return {
      rows: selected,
      intervals: selectedIntervals,
      tasks: fixtureTasksToReclaim(tasks, registeredProjects),
    }
  }
  let selectedTasks: FixtureTask[] = []
  writeTransaction((connection) => {
    const tasks = connection
      .query('SELECT key, project, title, opened_at FROM task ORDER BY key')
      .all() as FixtureTask[]
    selectedTasks = fixtureTasksToReclaim(tasks, registeredProjects)
    if (selected.length || selectedIntervals.length || selectedTasks.length) {
      const removeQuestion = connection.query('DELETE FROM question WHERE question_id=?')
      for (const row of selected) removeQuestion.run(row.question_id)
      const removeInterval = connection.query('DELETE FROM interval WHERE id=?')
      for (const interval of selectedIntervals) removeInterval.run(interval.id)
      const removeTaskComments = connection.query('DELETE FROM task_comment WHERE task_key=?')
      const removeTaskDocuments = connection.query('DELETE FROM task_document WHERE task_key=?')
      const removeTaskEvents = connection.query('DELETE FROM task_status_event WHERE task_key=?')
      const removeTask = connection.query('DELETE FROM task WHERE key=?')
      for (const task of selectedTasks) {
        removeTaskComments.run(task.key)
        removeTaskDocuments.run(task.key)
        removeTaskEvents.run(task.key)
        removeTask.run(task.key)
      }
    }
  })
  return { rows: selected, intervals: selectedIntervals, tasks: selectedTasks }
}
