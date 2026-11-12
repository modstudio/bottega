// concern: context-census
/** Pure coverage decision for architect-session task context. */

import { isOperatorSession } from '../caller-classification.ts'
import { taskFlowState } from '../workflow/task-flow-decision.ts'
import type { ContextItemKind } from './doc-context-write.ts'

export const CONTEXT_CENSUS_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000
export const CONTEXT_CENSUS_NOT_FULL_EXIT_CODE = 2

export type ContextCensusSession = {
  session: string
  lastSeen: string
  project: string | null
}

export type ContextCensusWork = {
  session: string
  key: string
  at: string
  project: string | null
}

type ContextCensusItem = {
  kind: ContextItemKind
  source: string
  updatedAt: string
}

export type ContextCensusTaskFact = {
  key: string
  project: string | null
  title: string | null
  statusCategory: string | null
  items: readonly ContextCensusItem[]
  unreadable: string | null
}

type ContextCensusTaskRow = {
  key: string
  project: string | null
  title: string | null
  status: 'covered' | 'uncovered' | 'unreadable'
  covered: number
  total: 1
  firstWorkedAt: string
  lastWorkedAt: string
  nextActionAt: string | null
  openQuestions: number
  rulings: number
  sources: Array<{ source: string; writingVerb: boolean }>
  remedy: string | null
}

export type ContextCensus = {
  since: string
  projects: Array<{
    project: string | null
    covered: number
    total: number
    sessions: Array<{
      session: string
      lastSeen: string
      covered: number
      total: number
      noHolder: boolean
      tasks: ContextCensusTaskRow[]
    }>
  }>
  verdict: {
    full: boolean
    uncovered: string[]
    unreadable: Array<{ task: string; remedy: string }>
  }
}

const sourceFromWritingVerb = (source: string) =>
  source === 'workflow-next' || source === 'pr-merge' || /^q\d+$/.test(source)

const latest = (values: readonly string[]) =>
  values.reduce<string | null>(
    (result, value) => (!result || value > result ? value : result),
    null,
  )

function taskRow(
  firstWorkedAt: string,
  lastWorkedAt: string,
  fact: ContextCensusTaskFact,
): ContextCensusTaskRow {
  const nextActionAt = latest(
    fact.items.filter(({ kind }) => kind === 'next-action').map(({ updatedAt }) => updatedAt),
  )
  const flowState = taskFlowState(fact.statusCategory)
  const closed = flowState === 'done' || flowState === 'dropped'
  const status = fact.unreadable
    ? 'unreadable'
    : closed || (nextActionAt !== null && nextActionAt >= firstWorkedAt)
      ? 'covered'
      : 'uncovered'
  return {
    key: fact.key,
    project: fact.project,
    title: fact.title,
    status,
    covered: status === 'covered' ? 1 : 0,
    total: 1,
    firstWorkedAt,
    lastWorkedAt,
    nextActionAt,
    openQuestions: fact.items.filter(({ kind }) => kind === 'open-question').length,
    rulings: fact.items.filter(({ kind }) => kind === 'ruling').length,
    sources: fact.items.map(({ source }) => ({
      source,
      writingVerb: sourceFromWritingVerb(source),
    })),
    remedy: fact.unreadable,
  }
}

function taskWorkSpans(work: readonly ContextCensusWork[]) {
  const spans = new Map<
    string,
    { event: ContextCensusWork; firstWorkedAt: string; lastWorkedAt: string }
  >()
  for (const event of work) {
    const identity = `${event.project ?? ''}\0${event.key}`
    const prior = spans.get(identity)
    if (!prior) {
      spans.set(identity, { event, firstWorkedAt: event.at, lastWorkedAt: event.at })
      continue
    }
    if (event.at < prior.firstWorkedAt) prior.firstWorkedAt = event.at
    if (event.at > prior.lastWorkedAt) prior.lastWorkedAt = event.at
  }
  return [...spans.values()]
}

/** Assign sessions to projects, compare work with revisions, and produce the one verdict. */
export function contextCensus(input: {
  since: string
  sessions: readonly ContextCensusSession[]
  work: readonly ContextCensusWork[]
  tasks: readonly ContextCensusTaskFact[]
}): ContextCensus {
  const recentWork = input.work.filter(({ at }) => at >= input.since)
  const facts = new Map(input.tasks.map((task) => [`${task.project ?? ''}\0${task.key}`, task]))
  const groups = new Map<string | null, Map<string, ContextCensusTaskRow[]>>()
  const addSession = (
    project: string | null,
    session: ContextCensusSession,
    work: ContextCensusWork[],
  ) => {
    const sessions = groups.get(project) ?? new Map<string, ContextCensusTaskRow[]>()
    groups.set(project, sessions)
    sessions.set(
      session.session,
      taskWorkSpans(work)
        .map(({ event, firstWorkedAt, lastWorkedAt }) => {
          const fact = facts.get(`${event.project ?? ''}\0${event.key}`) ?? {
            key: event.key,
            project: event.project,
            title: null,
            statusCategory: null,
            items: [],
            unreadable: 'task could not be read',
          }
          return taskRow(firstWorkedAt, lastWorkedAt, fact)
        })
        .sort((left, right) => left.key.localeCompare(right.key)),
    )
  }

  for (const session of input.sessions.filter(
    ({ session, lastSeen }) => !isOperatorSession(session) && lastSeen >= input.since,
  )) {
    const work = recentWork.filter((event) => event.session === session.session)
    if (session.project) addSession(session.project, session, work)
    else {
      const projects = [
        ...new Set(work.flatMap(({ project }) => (project ? [project] : []))),
      ].sort()
      for (const project of projects)
        addSession(
          project,
          session,
          work.filter((event) => event.project === project),
        )
      const unresolved = work.filter(({ project }) => project === null)
      if (unresolved.length > 0 || projects.length === 0) addSession(null, session, unresolved)
    }
  }

  const sessionFacts = new Map(input.sessions.map((session) => [session.session, session]))
  const projects = [...groups]
    .sort(([left], [right]) => (left ?? '').localeCompare(right ?? ''))
    .map(([project, sessions]) => {
      const rows = [...sessions]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([session, tasks]) => ({
          session,
          lastSeen: sessionFacts.get(session)!.lastSeen,
          covered: tasks.filter(({ status }) => status === 'covered').length,
          total: tasks.length,
          noHolder: tasks.length === 0,
          tasks,
        }))
      return {
        project,
        covered: rows.reduce((total, row) => total + row.covered, 0),
        total: rows.reduce((total, row) => total + row.total, 0),
        sessions: rows,
      }
    })
  const taskRows = projects.flatMap(({ sessions }) => sessions.flatMap(({ tasks }) => tasks))
  const uncovered = taskRows.filter(({ status }) => status === 'uncovered').map(({ key }) => key)
  const unreadable = taskRows
    .filter(
      (row): row is ContextCensusTaskRow & { remedy: string } =>
        row.status === 'unreadable' && row.remedy !== null,
    )
    .map(({ key, remedy }) => ({ task: key, remedy }))
  return {
    since: input.since,
    projects,
    verdict: { full: uncovered.length === 0 && unreadable.length === 0, uncovered, unreadable },
  }
}
