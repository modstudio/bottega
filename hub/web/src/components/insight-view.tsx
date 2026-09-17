import { useQuery } from '@tanstack/react-query'
import type { inferRouterOutputs } from '@trpc/server'
import { useEffect } from 'react'
import { responseSubtitle, WindowControl } from '@/components/design-system'
import { compactTokens, duration } from '@/lib/format'
import { isHostedMode } from '@/lib/hub-mode'
import { setWorkCounts, useWindowState } from '@/lib/window'
import { trpc } from '@/trpc/client'
import { Badge } from '@/ui/badge/badge'
import { PageHeader, SectionTitle } from '@/ui/page-header/page-header'
import { StatRow, StatTile } from '@/ui/stat/stat'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table/table'
import type { AppRouter } from '../../../src/trpc/router.ts'

type Outputs = inferRouterOutputs<AppRouter>['insight']
type InsightName = keyof Outputs
type RatioData = Outputs['ratio']['data']
type SpendData = Outputs['spend']['data']
type RoutingData = Outputs['routing']['data']
type HealthData = Outputs['health']['data']
type Strip = Omit<Outputs['ratio'], 'view' | 'data'>

const number = new Intl.NumberFormat('en-US')

const compact = compactTokens
const formatMs = duration

function pct(value: number | null) {
  return value == null ? '-' : `${Math.round(value * 100)}%`
}

function SectionHead({ title, detail }: { title: string; detail?: string }) {
  return <SectionTitle detail={detail}>{title}</SectionTitle>
}

function InsightChrome({ title, response }: { title: string; response: Strip }) {
  useEffect(() => setWorkCounts(response.counts), [response.counts])
  const subtitle = responseSubtitle(response)
  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle.text}
        subtitleTitle={subtitle.title}
        actions={<WindowControl />}
      />
      <StatRow>
        <StatTile
          figure={response.engaged}
          label="Engaged"
          live={response.activeAgents.length > 0}
        />
        <StatTile
          figure={response.activeAgents.length}
          label="Agents working"
          hint={response.activeAgents.join(', ') || 'No agent on a task'}
        />
        <StatTile
          figure={number.format(response.tasksShipped)}
          label="Tasks shipped"
          hint="Last 14 days"
        />
      </StatRow>
    </>
  )
}

function RatioView({ data }: { data: RatioData }) {
  const drawn = data.days.filter((day) => day.ratio != null || day.excluded)
  const top = Math.ceil(Math.max(1, ...drawn.map((day) => day.ratio || 0)) / 25e6) * 25e6 || 25e6
  const ticks = [1, 0.75, 0.5, 0.25, 0]
  return (
    <>
      <p className="mb-3 text-text-muted">The one number every routing decision exists to move.</p>
      <StatRow>
        <StatTile
          figure={compact(data.perTask)}
          label="Tokens per task"
          hint={`${compact(data.tokens)} over ${number.format(data.tasks)} tasks, ${data.usableDays} usable days`}
        />
        <StatTile
          figure={data.direction}
          label="Trend"
          hint={
            data.changePct == null
              ? 'Not enough tasks in each half to say'
              : `${data.changePct > 0 ? '+' : ''}${data.changePct.toFixed(0)}%, halves of the window`
          }
        />
        <StatTile figure="Lower" label="Direction" hint="A fall means less spend, or more tasks" />
      </StatRow>
      <div className="mt-5 flex h-[280px] min-w-0 border border-border-default p-3">
        <div className="flex w-16 shrink-0 flex-col justify-between pb-7 text-right text-xs text-text-muted">
          {ticks.map((tick) => (
            <span key={tick}>{compact(top * tick)}</span>
          ))}
        </div>
        <div className="ml-3 flex min-w-0 flex-1 items-end gap-2 overflow-x-auto border-b border-l border-border-default px-2">
          {drawn.map((day) => {
            const height =
              day.excluded === 'gap'
                ? 20
                : Math.min(226, Math.max(3, Math.round(((day.ratio || 0) / top) * 226)))
            const label =
              day.excluded === 'gap'
                ? 'no data'
                : day.excluded === 'today'
                  ? 'partial'
                  : compact(day.ratio)
            return (
              <div
                key={day.day}
                className="flex h-full min-w-10 flex-1 flex-col items-center justify-end"
              >
                <span className="mb-1 whitespace-nowrap text-xs text-text-muted">{label}</span>
                <div
                  className={`w-7 border border-chart-1 ${day.excluded === 'gap' ? 'bg-[repeating-linear-gradient(135deg,transparent,transparent_3px,var(--border-default)_3px,var(--border-default)_5px)]' : day.excluded === 'today' ? 'bg-surface-sunken' : 'bg-chart-1'}`}
                  style={{ height }}
                />
                <span className="mt-1 text-xs text-text-muted">{day.day.slice(5)}</span>
              </div>
            )
          })}
        </div>
      </div>
      <p className="max-w-[72ch] mt-4 text-text-muted">
        Hatched days are drawn but not counted. A day carrying tasks with almost no tokens is a gap,
        not efficiency - work done on the other machine, whose transcripts are not here - and today
        is still accruing spend against commits that have not landed. Reading either as a ratio
        flatters it by orders of magnitude.
      </p>
    </>
  )
}

function SpendView({ data }: { data: SpendData }) {
  const mixTotal = Object.values(data.lineMix).reduce((sum, value) => sum + value, 0) || 1
  const mix = Object.entries(data.lineMix).sort((a, b) => b[1] - a[1])
  return (
    <>
      <p className="mb-3 text-text-muted">
        Each currency against five denominators, {data.days} usable days from {data.from}.
      </p>
      <div className="overflow-x-auto border border-border-default">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Per</TableHead>
              {data.numerators.map((item) => (
                <TableHead key={`${item.kind}:${item.name}`} numeric>
                  {item.kind === 'usd'
                    ? item.name.charAt(0).toUpperCase() + item.name.slice(1)
                    : item.name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {Object.entries(data.denominators).map(([name, denominator]) => (
              <TableRow key={name}>
                <TableCell>
                  <span className="font-semibold">
                    {name}
                    {name === 'engaged hour' ? <Badge className="ml-2">new</Badge> : null}
                  </span>
                </TableCell>
                {data.numerators.map((item) => {
                  if (!denominator)
                    return (
                      <TableCell key={`${name}:${item.name}`} numeric muted>
                        -
                      </TableCell>
                    )
                  const value = item.total / denominator
                  return (
                    <TableCell key={`${name}:${item.name}`} numeric>
                      <span
                        className={item.name === 'claude' ? 'font-semibold' : 'text-text-muted'}
                      >
                        {item.kind === 'usd'
                          ? `$${value.toFixed(value < 1 ? 4 : 2)}`
                          : compact(value)}
                      </span>
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="mt-5 grid gap-8 md:grid-cols-2">
        <p className="max-w-[72ch] text-text-muted">
          <strong className="text-text-primary">No denominator here is trustworthy alone</strong>,
          and the signal is whether they agree. Tasks miss work carrying no ticket; lines reward
          verbosity; commits follow habit; files say nothing about depth. Engaged hour is the only
          one that depends on none of those.
          <br />
          <br />
          <strong className="text-text-primary">
            Columns are separate currencies and are never summed.
          </strong>{' '}
          Two runs doing comparable work on the same question reported 452,860 tokens and 91,996.
          That gap is about how each vendor counts.
        </p>
        <div>
          <div className="mb-2 font-semibold text-text-muted">Line churn</div>
          {mix.map(([name, value]) => {
            const percentage = Math.round((value / mixTotal) * 100)
            return (
              <div key={name} className="mb-2">
                <div className="flex justify-between">
                  <span className="text-text-muted">{name}</span>
                  <span>{percentage}%</span>
                </div>
                <div className="h-1 bg-surface-sunken">
                  <div
                    className="h-full bg-chart-1"
                    style={{ width: `${Math.max(2, percentage)}%` }}
                  />
                </div>
              </div>
            )
          })}
          <div className="mt-3 text-text-muted">
            Generated output is excluded from the line denominator: one migration rewrites a
            25k-line snapshot, so a one-column change reads as a 23,000-line day.
          </div>
        </div>
      </div>
    </>
  )
}

type GuideCandidate = {
  agent: string
  score: number | null
  evidence: number
  latencyMs: number | null
}

function GuideCell({ candidate, lead }: { candidate: unknown; lead: 'score' | 'time' }) {
  if (!candidate) return <span className="text-text-muted">-</span>
  const value = candidate as GuideCandidate
  const score = `${pct(value.score)} of ${value.evidence}`
  const time = value.latencyMs != null ? formatMs(value.latencyMs) : '-'
  return (
    <>
      <strong>{value.agent}</strong>{' '}
      <span className="text-text-muted">
        {lead === 'time' ? `${time} - ${score}` : `${score} - ${time}`}
      </span>
    </>
  )
}

const bucketLabel = (bucket: 'small' | 'large' | null) =>
  bucket === 'small' ? '<16 KiB' : bucket === 'large' ? '>=16 KiB' : null

export function RoutingView({ data }: { data: RoutingData }) {
  const jobs = [...new Set(data.matrix.map((cell) => `${cell.job}:${cell.promptBucket}`))].sort()
  const agents = [...new Set(data.matrix.map((cell) => cell.agent))].sort()
  const at = (jobBucket: string, agent: string) =>
    data.matrix.find(
      (cell) => `${cell.job}:${cell.promptBucket}` === jobBucket && cell.agent === agent,
    )
  const blockerLine = (value: string | null) =>
    value && value.length > 160 ? `${value.slice(0, 157)}...` : value
  return (
    <>
      <SectionHead
        title="What to use for what"
        detail={`${data.unscored} runs unscored - an unscored run teaches the router nothing`}
      />
      <div className="overflow-x-auto border border-border-default">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job / prompt bucket</TableHead>
              <TableHead>Best by score</TableHead>
              <TableHead>Quickest</TableHead>
              <TableHead>Never tried</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.guide.map((row) => (
              <TableRow key={`${row.job}:${row.promptBucket ?? 'empty'}`}>
                <TableCell>
                  <span className="font-semibold">
                    {row.job}
                    {bucketLabel(row.promptBucket) ? ` [${bucketLabel(row.promptBucket)}]` : ''}
                  </span>
                </TableCell>
                <TableCell>
                  <GuideCell candidate={row.best} lead="score" />
                  {row.provisional ? <Badge className="ml-2">provisional</Badge> : null}
                </TableCell>
                <TableCell>
                  <GuideCell candidate={row.quickest} lead="time" />
                </TableCell>
                <TableCell muted>{row.untried?.join(', ') || '-'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <SectionHead
        title="Score by agent, job and prompt bucket"
        detail="the router's own scoreboard, over judgements not runs"
      />
      <div className="overflow-x-auto border border-border-default">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Job / prompt bucket</TableHead>
              {agents.map((agent) => (
                <TableHead key={agent} numeric>
                  {agent}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((jobBucket) => (
              <TableRow key={jobBucket}>
                <TableCell>
                  <span className="font-semibold">
                    {jobBucket.replace(':small', ' [<16 KiB]').replace(':large', ' [>=16 KiB]')}
                  </span>
                </TableCell>
                {agents.map((agent) => {
                  const cell = at(jobBucket, agent)
                  if (!cell)
                    return (
                      <TableCell key={agent} numeric muted>
                        -
                      </TableCell>
                    )
                  const score = cell.judged ? cell.pts / cell.judged : null
                  const title = `${cell.runs} runs, ${cell.failures} failed${cell.lat != null ? `, median ${formatMs(cell.lat)}` : ''}`
                  return (
                    <TableCell key={agent} numeric title={title}>
                      {pct(score)} <span className="text-text-muted">/{cell.judged}</span>
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <div>
          <SectionHead
            title="Agents"
            detail={`${data.totals.runs} runs, ${data.totals.failed} failed, ${data.stale} stale`}
          />
          <div className="overflow-x-auto border border-border-default">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead>Billing</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Last failure</TableHead>
                  <TableHead numeric>Last run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.health.map((row) => (
                  <TableRow key={row.agent}>
                    <TableCell>
                      <span className="font-semibold">{row.agent}</span>
                    </TableCell>
                    <TableCell muted>{row.billing}</TableCell>
                    <TableCell>
                      {row.cooling ? (
                        <Badge>cooling {row.cooling}</Badge>
                      ) : row.lastStatus === 'ok' ? (
                        <Badge tone="success">OK</Badge>
                      ) : row.lastStatus ? (
                        <Badge tone="error">{row.lastStatus}</Badge>
                      ) : (
                        <span className="text-text-muted">no runs</span>
                      )}
                    </TableCell>
                    <TableCell muted>{row.lastKind || '-'}</TableCell>
                    <TableCell numeric muted>
                      {row.minsAgo != null ? `${Math.round(row.minsAgo)}m ago` : '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <SectionHead
            title="Recurring blockers"
            detail={`last ${data.blockerDays} day${data.blockerDays === 1 ? '' : 's'}`}
          />
          <div className="overflow-x-auto border border-border-default">
            {data.blockers == null ? (
              <div className="p-6 text-center text-text-muted">
                Blocker data is unavailable. Agent health and routing are still available.
              </div>
            ) : data.blockers.length === 0 ? (
              <div className="p-6 text-center text-text-muted">
                No environment blockers were reported in this window.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Blocker</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead numeric>Runs</TableHead>
                    <TableHead numeric>Projects</TableHead>
                    <TableHead>Agents</TableHead>
                    <TableHead>Example</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.blockers.map((row) => {
                    const example = blockerLine(row.example)
                    return (
                      <TableRow key={`${row.source}:${row.kind ?? row.example ?? 'unknown'}`}>
                        <TableCell>
                          <span className="font-semibold">{row.kind ?? example ?? '-'}</span>
                        </TableCell>
                        <TableCell>
                          <Badge>{row.source === 'detected' ? 'detected' : 'declared'}</Badge>
                        </TableCell>
                        <TableCell numeric>{number.format(row.runs)}</TableCell>
                        <TableCell numeric>{number.format(row.projects)}</TableCell>
                        <TableCell>{row.agents?.join(', ') || '-'}</TableCell>
                        <TableCell muted title={row.example ?? ''}>
                          {row.kind == null ? 'shown as blocker' : example || '-'}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </div>
          <p className="mt-4 text-text-muted">
            <strong className="text-text-primary">
              These are environment problems, not agent failures.
            </strong>{' '}
            An agent that hit one carried on and reported it. They are ordered by runs affected, so
            the machine problems costing the most verification stay at the top.
          </p>
        </div>

        <div>
          {data.spawns?.length ? (
            <>
              <SectionHead title="Subagent gate" detail="what it allowed and denied, and why" />
              <div className="overflow-x-auto border border-border-default">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Decision</TableHead>
                      <TableHead>Why</TableHead>
                      <TableHead numeric>N</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.spawns.map((row) => (
                      <TableRow key={`${row.decision}:${row.why}`}>
                        <TableCell>
                          <Badge tone={row.decision === 'denied' ? 'error' : 'neutral'}>
                            {row.decision}
                          </Badge>
                        </TableCell>
                        <TableCell muted>{row.why}</TableCell>
                        <TableCell numeric>{number.format(row.n)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          ) : null}
          {data.byRepo?.length ? (
            <>
              <SectionHead title="Vendor spend by project" detail="successful runs only" />
              <div className="overflow-x-auto border border-border-default">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Project</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead numeric>Runs</TableHead>
                      <TableHead numeric>Tokens</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.byRepo.slice(0, 18).map((row) => (
                      <TableRow key={`${row.repo}:${row.agent}`}>
                        <TableCell>{row.repo === '-' ? 'elsewhere' : row.repo}</TableCell>
                        <TableCell>{row.agent}</TableCell>
                        <TableCell numeric>{number.format(row.runs)}</TableCell>
                        <TableCell numeric muted>
                          {compact(row.toks)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          ) : null}
        </div>
      </div>
      <p className="mt-5 max-w-4xl text-text-muted">
        <strong className="text-text-primary">
          A run that produced nothing counts against the agent.
        </strong>{' '}
        Reading only successful runs made failure invisible: an agent that fails most of the time
        but scores well on the few that land looked flawless. The denominator here is judgements,
        which includes failures.
      </p>
    </>
  )
}

export function HealthView({ data }: { data: HealthData }) {
  const rows = data.classes
  const formatTime = (ms: number) =>
    ms < 60_000
      ? `${(ms / 1000).toFixed(1)}s`
      : ms < 3_600_000
        ? `${(ms / 60_000).toFixed(1)}m`
        : `${(ms / 3_600_000).toFixed(1)}h`
  return (
    <>
      <p className="mb-3 text-text-muted">{data.header}</p>
      <div className="overflow-x-auto border border-border-default">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Failure class</TableHead>
              <TableHead numeric>Count</TableHead>
              <TableHead numeric>Total</TableHead>
              <TableHead numeric>Mean</TableHead>
              <TableHead>Last seen</TableHead>
              <TableHead>Window activity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const peak = Math.max(1, ...row.sparkline.map((point) => point.count))
              return (
                <TableRow key={row.kind}>
                  <TableCell>
                    <span className="font-semibold">{row.kind}</span>
                  </TableCell>
                  <TableCell numeric>{row.count}</TableCell>
                  <TableCell numeric>{formatTime(row.totalTimeMs)}</TableCell>
                  <TableCell numeric muted>
                    {formatTime(row.meanTimeMs)}
                  </TableCell>
                  <TableCell muted>{row.lastSeen ? row.lastSeen.slice(0, 10) : '-'}</TableCell>
                  <TableCell>
                    <div
                      className="flex h-6 items-end gap-px"
                      title={row.sparkline
                        .map((point) => `${point.day}: ${point.count}`)
                        .join('\n')}
                    >
                      {row.sparkline.map((point) => (
                        <span
                          key={point.day}
                          className="w-1.5 bg-chart-1"
                          style={{
                            height: point.count
                              ? `${Math.max(3, Math.round((point.count / peak) * 24))}px`
                              : '1px',
                            opacity: point.count ? 1 : 0.15,
                          }}
                        />
                      ))}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <SectionHead
        title="False harness verdicts"
        detail={`${data.landingRefusals} landing refusal${data.landingRefusals === 1 ? '' : 's'} reported separately`}
      />
      <div className="overflow-x-auto border border-border-default">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead numeric>Later cleared or voided</TableHead>
              <TableHead numeric>All verdicts</TableHead>
              <TableHead numeric>Rate</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.falseVerdicts
              .filter((row) => row.verdicts > 0)
              .map((row) => (
                <TableRow key={row.kind}>
                  <TableCell>
                    <span className="font-semibold">{row.kind}</span>
                  </TableCell>
                  <TableCell numeric>{row.falseVerdicts}</TableCell>
                  <TableCell numeric>{row.verdicts}</TableCell>
                  <TableCell numeric>{(row.rate * 100).toFixed(1)}%</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>
      {data.provenance?.length ? (
        <>
          <SectionHead
            title="Lens provenance"
            detail="substituted sources and silent negative space by agent"
          />
          <div className="overflow-x-auto border border-border-default">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Agent</TableHead>
                  <TableHead numeric>Substituted</TableHead>
                  <TableHead numeric>Silent</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.provenance.map((row) => (
                  <TableRow key={row.agent}>
                    <TableCell>{row.agent}</TableCell>
                    <TableCell numeric>{row.substituted}</TableCell>
                    <TableCell numeric>{row.silent}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      ) : null}
    </>
  )
}

function RatioQuery() {
  return isHostedMode() ? <HostedRatioQuery /> : <LocalRatioQuery />
}

function LocalRatioQuery() {
  const windowState = useWindowState()
  const input = { hours: windowState.hours, filters: windowState.filters }
  const query = useQuery(trpc.insight.ratio.queryOptions(input, { refetchInterval: 10_000 }))
  if (query.isPending) return <p className="text-text-muted">Loading ratio...</p>
  if (query.error)
    return (
      <p data-tone="error" className="text-status-text">
        could not load: {query.error.message}
      </p>
    )
  return (
    <section>
      <InsightChrome title="Ratio" response={query.data} />
      <RatioView data={query.data.data} />
    </section>
  )
}

function HostedRatioQuery() {
  const windowState = useWindowState()
  const query = useQuery(trpc.record.ratio.queryOptions({ hours: windowState.hours, filters: { ...windowState.filters, source: '' } }, { refetchInterval: 10_000 }))
  if (query.isPending) return <p className="text-text-muted">Loading ratio...</p>
  if (query.error) return <p data-tone="error" className="text-status-text">could not load: {query.error.message}</p>
  return <section><InsightChrome title="Ratio" response={query.data} /><RatioView data={query.data.data} /></section>
}

function SpendQuery() {
  return isHostedMode() ? <HostedSpendQuery /> : <LocalSpendQuery />
}

function LocalSpendQuery() {
  const windowState = useWindowState()
  const input = { hours: windowState.hours, filters: windowState.filters }
  const query = useQuery(trpc.insight.spend.queryOptions(input, { refetchInterval: 10_000 }))
  if (query.isPending) return <p className="text-text-muted">Loading spend...</p>
  if (query.error)
    return (
      <p data-tone="error" className="text-status-text">
        could not load: {query.error.message}
      </p>
    )
  return (
    <section>
      <InsightChrome title="Spend" response={query.data} />
      <SpendView data={query.data.data} />
    </section>
  )
}

function HostedSpendQuery() {
  const windowState = useWindowState()
  const query = useQuery(trpc.record.spend.queryOptions({ hours: windowState.hours, filters: { ...windowState.filters, source: '' } }, { refetchInterval: 10_000 }))
  if (query.isPending) return <p className="text-text-muted">Loading spend...</p>
  if (query.error) return <p data-tone="error" className="text-status-text">could not load: {query.error.message}</p>
  return <section><InsightChrome title="Spend" response={query.data} /><SpendView data={query.data.data} /></section>
}

function RoutingQuery() {
  const windowState = useWindowState()
  const input = { hours: windowState.hours, filters: windowState.filters }
  const query = useQuery(trpc.insight.routing.queryOptions(input, { refetchInterval: 30_000 }))
  if (query.isPending) return <p className="text-text-muted">Loading routing...</p>
  if (query.error)
    return (
      <p data-tone="error" className="text-status-text">
        could not load: {query.error.message}
      </p>
    )
  return (
    <section>
      <InsightChrome title="Routing" response={query.data} />
      <RoutingView data={query.data.data} />
    </section>
  )
}

function HealthQuery() {
  const windowState = useWindowState()
  const input = { hours: windowState.hours, filters: windowState.filters }
  const query = useQuery(trpc.insight.health.queryOptions(input, { refetchInterval: 30_000 }))
  if (query.isPending) return <p className="text-text-muted">Loading health...</p>
  if (query.error)
    return (
      <p data-tone="error" className="text-status-text">
        could not load: {query.error.message}
      </p>
    )
  return (
    <section>
      <InsightChrome title="Health" response={query.data} />
      <HealthView data={query.data.data} />
    </section>
  )
}

export function InsightView({ name }: { name: InsightName }) {
  if (name === 'health') return <HealthQuery />
  if (name === 'ratio') return <RatioQuery />
  if (name === 'spend') return <SpendQuery />
  return <RoutingQuery />
}
