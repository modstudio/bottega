import { PHONE_QUERY, useMediaQuery } from '@bottega/hub-ui/dom/use-media-query'
import { Select } from '@bottega/hub-ui/listbox/select'
import { PageHeader, SectionTitle } from '@bottega/hub-ui/page-header'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@bottega/hub-ui/table'
import { ToolbarBand } from '@bottega/hub-ui/toolbar-band'
import { WindowControl } from '@/components/design-system'
import {
  AgentUnknown,
  CostUnknown,
  MeasuresSummary,
  measureFormat,
  SessionDetail,
} from '@/components/measure-display'

type ScopeKind = 'space' | 'project' | 'person'
type Sampled = { sample: { intervalCount: number } }
/** The summary's measures plus the sample sizes the breakdown tables print. */
type Measures = Parameters<typeof MeasuresSummary>[0]['measures'] & {
  hoursRunning: Sampled
  agentHours: Sampled
  sessionTime: Sampled
  cost: Sampled
  shipped?: { count: number; sample: { eventCount: number } }
}
type Project = { name: string }
type Person = { userId: string; name: string }
type MeasureQuery = { data?: Measures }

export function HostedReports({
  kind,
  onKindChange,
  projects,
  people,
  project,
  person,
  onProjectChange,
  onPersonChange,
  title,
  measures,
  measuresError,
  sortedProjects,
  projectMeasures,
  projectPeople,
  personMeasures,
}: {
  kind: ScopeKind
  onKindChange(kind: ScopeKind): void
  projects: Project[]
  people: Person[]
  project: string
  person: string
  onProjectChange(project: string): void
  onPersonChange(person: string): void
  title: string | undefined
  measures: Measures | undefined
  measuresError: string | null
  sortedProjects: Project[]
  projectMeasures: readonly MeasureQuery[]
  projectPeople: Person[]
  personMeasures: readonly MeasureQuery[]
}) {
  const phone = useMediaQuery(PHONE_QUERY)
  const scope = (
    <>
      <WindowControl />
      <Select
        size="sm"
        label="Report scope"
        value={kind}
        options={[
          { value: 'space', label: 'This space' },
          { value: 'project', label: 'One project', disabled: !projects.length },
          { value: 'person', label: 'One person', disabled: !people.length },
        ]}
        onChange={(value) => onKindChange(value as ScopeKind)}
      />
      {kind === 'project' ? (
        <Select
          size="sm"
          label="Project"
          value={project}
          options={projects.map((row) => ({ value: row.name, label: row.name }))}
          onChange={onProjectChange}
        />
      ) : null}
      {kind === 'person' ? (
        <Select
          size="sm"
          label="Person"
          value={person}
          options={people.map((row) => ({ value: row.userId, label: row.name }))}
          onChange={onPersonChange}
        />
      ) : null}
    </>
  )
  return (
    <section>
      <PageHeader
        title="Reports"
        subtitle={title || 'Choose a scope'}
        actions={phone ? <ToolbarBand scope={scope} /> : scope}
      />
      {measuresError ? (
        <p data-tone="error" className="text-status-text">
          {measuresError}
        </p>
      ) : null}
      {measures ? (
        <MeasuresSummary measures={measures} />
      ) : (
        <p className="text-text-muted">Loading measures...</p>
      )}
      {kind === 'space' ? (
        <ProjectBreakdown projects={sortedProjects} queries={projectMeasures} />
      ) : null}
      {kind === 'project' ? (
        <PersonBreakdown people={projectPeople} queries={personMeasures} unknown={measures} />
      ) : null}
    </section>
  )
}

export function ProjectBreakdown({
  projects,
  queries,
}: {
  projects: { name: string }[]
  queries: readonly MeasureQuery[]
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
              <TableHead>Done</TableHead>
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
                    {value?.shipped ? (
                      <>
                        {value.shipped.count}
                        <div className="text-xs text-text-muted">
                          Tasks moved to done in this window · {value.shipped.sample.eventCount}{' '}
                          events
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
  queries: readonly MeasureQuery[]
  unknown: Measures | undefined
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
