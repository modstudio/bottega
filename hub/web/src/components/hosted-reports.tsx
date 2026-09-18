import { useQueries, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { WindowControl } from '@/components/design-system'
import {
  AgentUnknown,
  CostUnknown,
  MeasuresSummary,
  measureFormat,
  SessionDetail,
} from '@/components/measure-display'
import { useWindowState } from '@/lib/window'
import { type MeasuresResponse, trpc } from '@/trpc/client'
import { Select } from '@/ui/listbox/select'
import { PageHeader, SectionTitle } from '@/ui/page-header/page-header'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table/table'

type ScopeKind = 'space' | 'project' | 'person'

function selectedScope(kind: ScopeKind, project: string, person: string) {
  if (kind === 'project' && project) return { kind, project } as const
  if (kind === 'person' && person) return { kind, userId: person } as const
  return { kind: 'space' } as const
}

export function HostedReports() {
  const { hours } = useWindowState()
  const [kind, setKind] = useState<ScopeKind>('space')
  const [chosenProject, setChosenProject] = useState('')
  const [chosenPerson, setChosenPerson] = useState('')
  const window = useMemo(() => {
    const to = Date.now()
    return { from: new Date(to - hours * 3_600_000).toISOString(), to: new Date(to).toISOString() }
  }, [hours])
  const projects = useQuery(trpc.record.projects.queryOptions())
  const people = useQuery(trpc.record.measurePeople.queryOptions(window))
  const project = chosenProject || projects.data?.[0]?.name || ''
  const person = chosenPerson || people.data?.[0]?.userId || ''
  const scope = selectedScope(kind, project, person)
  const measures = useQuery(trpc.record.measures.queryOptions({ ...window, scope }))
  const sortedProjects = [...(projects.data ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  )
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
    queries: (kind === 'project' ? (projectPeople.data ?? []) : []).map((row) =>
      trpc.record.measures.queryOptions({
        ...window,
        scope: { kind: 'person', userId: row.userId, project },
      }),
    ),
  })
  const namedPerson = people.data?.find((row) => row.userId === person)?.name
  const title = kind === 'space' ? 'This space' : kind === 'project' ? project : namedPerson

  return (
    <section>
      <PageHeader
        title="Reports"
        subtitle={title || 'Choose a scope'}
        actions={
          <>
            <WindowControl />
            <Select
              size="sm"
              label="Report scope"
              value={kind}
              options={[
                { value: 'space', label: 'This space' },
                { value: 'project', label: 'One project', disabled: !projects.data?.length },
                { value: 'person', label: 'One person', disabled: !people.data?.length },
              ]}
              onChange={(value) => setKind(value as ScopeKind)}
            />
            {kind === 'project' ? (
              <Select
                size="sm"
                label="Project"
                value={project}
                options={(projects.data ?? []).map((row) => ({ value: row.name, label: row.name }))}
                onChange={setChosenProject}
              />
            ) : null}
            {kind === 'person' ? (
              <Select
                size="sm"
                label="Person"
                value={person}
                options={(people.data ?? []).map((row) => ({ value: row.userId, label: row.name }))}
                onChange={setChosenPerson}
              />
            ) : null}
          </>
        }
      />
      {measures.error ? (
        <p data-tone="error" className="text-status-text">
          {measures.error.message}
        </p>
      ) : null}
      {measures.data ? (
        <MeasuresSummary measures={measures.data} />
      ) : (
        <p className="text-text-muted">Loading measures...</p>
      )}
      {kind === 'space' ? (
        <ProjectBreakdown projects={sortedProjects} queries={projectMeasures} />
      ) : null}
      {kind === 'project' ? (
        <PersonBreakdown
          people={projectPeople.data ?? []}
          queries={personMeasures}
          unknown={measures.data}
        />
      ) : null}
    </section>
  )
}

export function ProjectBreakdown({
  projects,
  queries,
}: {
  projects: { name: string }[]
  queries: readonly { data?: MeasuresResponse }[]
}) {
  return (
    <>
      <SectionTitle>By project</SectionTitle>
      <div className="overflow-x-auto border border-border-default">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Hours running</TableHead>
              <TableHead>Agent-hours started</TableHead>
              <TableHead>Session time</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Landed</TableHead>
              <TableHead>Cycle time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((project, index) => {
              const value = queries[index]?.data
              return (
                <TableRow key={project.name}>
                  <TableCell>{project.name}</TableCell>
                  <TableCell>
                    {value ? (
                      <>
                        {measureFormat.hour(value.hoursRunning.unionMs)}
                        <div className="text-xs text-text-muted">
                          {value.hoursRunning.sample.intervalCount} intervals; not additive
                        </div>
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    {value ? (
                      <>
                        {measureFormat.hour(value.agentHours.sumMs)}
                        <div className="text-xs text-text-muted">
                          {value.agentHours.sample.intervalCount} intervals ·{' '}
                          <AgentUnknown measure={value.agentHours} />
                        </div>
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    {value ? (
                      <>
                        {measureFormat.hour(value.sessionTime.unionThenSumMs)}
                        <div className="max-w-xs text-xs text-text-muted">
                          {value.sessionTime.sample.intervalCount} intervals ·{' '}
                          <SessionDetail measure={value.sessionTime} />
                        </div>
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    {value ? (
                      <>
                        {measureFormat.money(value.cost.vendorCostUsd)}
                        <div className="text-xs text-text-muted">
                          {value.cost.sample.intervalCount} intervals ·{' '}
                          <CostUnknown measure={value.cost} />
                        </div>
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    {value && 'shipped' in value ? (
                      <>
                        {value.shipped.count}
                        <div className="text-xs text-text-muted">
                          {value.shipped.sample.eventCount} events
                        </div>
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    {value && 'cycleTime' in value && value.cycleTime ? (
                      <>
                        {measureFormat.hour(value.cycleTime.medianMs)} · n={value.cycleTime.n}
                      </>
                    ) : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </>
  )
}

function PersonBreakdown({
  people,
  queries,
  unknown,
}: {
  people: { userId: string; name: string }[]
  queries: readonly { data?: MeasuresResponse }[]
  unknown: MeasuresResponse | undefined
}) {
  return (
    <>
      <SectionTitle
        detail={
          unknown ? (
            <>
              <AgentUnknown measure={unknown.agentHours} />;{' '}
              <SessionDetail measure={unknown.sessionTime} />
            </>
          ) : null
        }
      >
        By person
      </SectionTitle>
      <div className="overflow-x-auto border border-border-default">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead>What they started</TableHead>
              <TableHead>Their session time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {people.map((person, index) => {
              const value = queries[index]?.data
              return (
                <TableRow key={person.userId}>
                  <TableCell>{person.name}</TableCell>
                  <TableCell>
                    {value ? (
                      <>
                        <span>started {measureFormat.hour(value.agentHours.sumMs)}</span>
                        <div className="text-xs text-text-muted">
                          {value.agentHours.sample.intervalCount} intervals
                        </div>
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>
                    {value ? (
                      <>
                        <span>
                          in session {measureFormat.hour(value.sessionTime.unionThenSumMs)}
                        </span>
                        <div className="max-w-xs text-xs text-text-muted">
                          {value.sessionTime.sample.intervalCount} intervals ·{' '}
                          <SessionDetail measure={value.sessionTime} />
                        </div>
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </>
  )
}
