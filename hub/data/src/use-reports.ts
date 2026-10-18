import { useQueries, useQuery } from '@tanstack/react-query'
import { trpc } from './client.ts'
import { useHostedProjects } from './use-projects.ts'

export type HostedReportScopeKind = 'space' | 'project' | 'person'

type ReportWindow = { from: string; to: string }
type ReportSelection = {
  kind: HostedReportScopeKind
  chosenProject: string
  chosenPerson: string
}

function selectedScope(kind: HostedReportScopeKind, project: string, person: string) {
  if (kind === 'project' && project) return { kind, project } as const
  if (kind === 'person' && person) return { kind, userId: person } as const
  return { kind: 'space' } as const
}

export function useHostedReports(window: ReportWindow, selection: ReportSelection) {
  const { projects } = useHostedProjects()
  const people = useQuery(trpc.record.measurePeople.queryOptions(window))
  const project = selection.chosenProject || projects[0]?.name || ''
  const person = selection.chosenPerson || people.data?.[0]?.userId || ''
  const scope = selectedScope(selection.kind, project, person)
  const measures = useQuery(trpc.record.measures.queryOptions({ ...window, scope }))
  const sortedProjects = [...projects].sort((left, right) => left.name.localeCompare(right.name))
  const projectMeasures = useQueries({
    queries: sortedProjects.map((row) =>
      trpc.record.measures.queryOptions({
        ...window,
        scope: { kind: 'project', project: row.name },
      }),
    ),
  })
  const projectPeople = useQuery(
    trpc.record.measurePeople.queryOptions({ ...window, ...(project ? { project } : {}) }),
  )
  const personMeasures = useQueries({
    queries: (selection.kind === 'project' ? (projectPeople.data ?? []) : []).map((row) =>
      trpc.record.measures.queryOptions({
        ...window,
        scope: { kind: 'person', userId: row.userId, project },
      }),
    ),
  })
  const namedPerson = people.data?.find((row) => row.userId === person)?.name

  return {
    projects,
    people: people.data ?? [],
    project,
    person,
    title:
      selection.kind === 'space'
        ? 'This space'
        : selection.kind === 'project'
          ? project
          : namedPerson,
    measures: measures.data,
    measuresError: measures.error?.message ?? null,
    sortedProjects,
    projectMeasures: projectMeasures.map((query) => ({ data: query.data })),
    projectPeople: projectPeople.data ?? [],
    personMeasures: personMeasures.map((query) => ({ data: query.data })),
  }
}
