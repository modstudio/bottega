import { PHONE_QUERY, useMediaQuery } from '@bottega/hub-ui/dom/use-media-query'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { StatRow, StatTile } from '@bottega/hub-ui/stat'
import { ToolbarBand } from '@bottega/hub-ui/toolbar-band'
import { type ReactNode, useEffect } from 'react'
import { responseSubtitle, useWindowFilters, WindowControl } from '@/components/design-system'
import { setWorkCounts } from '@/lib/window'

const number = new Intl.NumberFormat('en-US')

/** What every work page's response carries for its header and figures. */
export type ChromeResponse = {
  engaged: string
  activeAgents: string[]
  tasksShipped: number
  collectedAt: string | null
  servingSince: string
  counts: { flight: number; done: number; runs: number }
}

export type Facets = { projects: string[]; agents: string[]; sources: string[] }

type ChromeFigures = Pick<
  ChromeResponse,
  'engaged' | 'activeAgents' | 'tasksShipped' | 'collectedAt' | 'servingSince' | 'counts'
>

/** The window's headline figures. */
export function WorkStats({ response }: { response: ChromeFigures }) {
  return (
    <StatRow>
      <StatTile figure={response.engaged} label="Engaged" live={response.activeAgents.length > 0} />
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
  )
}

/**
 * The page's header and figures. On a phone every control joins one band: a page with a
 * TableCard hands the window and figures to the card's band (`inCard`); a page without one
 * shows its own band here, with whatever else the page controls (`phoneBand`).
 */
export function WindowChrome({
  title,
  response,
  facets,
  onDropdown,
  headerFilters = false,
  phoneBand,
}: {
  title: string
  response: ChromeFigures
  facets: Facets
  onDropdown: (open: boolean) => void
  /** A page without a TableCard shows its filters beside the window instead. */
  headerFilters?: boolean
  /** On a phone, the page's own search and view controls for its band. */
  phoneBand?: { search?: ReactNode; view?: ReactNode }
}) {
  useEffect(() => setWorkCounts(response.counts), [response.counts])
  const filters = useWindowFilters({ ...facets, onOpenChange: onDropdown })
  const subtitle = responseSubtitle(response)
  const phone = useMediaQuery(PHONE_QUERY)
  if (phone) {
    if (!headerFilters) return <PageHeader title={title} />
    return (
      <>
        <PageHeader
          title={title}
          actions={
            <ToolbarBand
              scope={<WindowControl />}
              filters={filters.controls}
              filtersActive={filters.active > 0}
              search={phoneBand?.search}
              view={phoneBand?.view}
            />
          }
        />
        <WorkStats response={response} />
      </>
    )
  }
  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle.text}
        subtitleTitle={subtitle.title}
        actions={
          <>
            {headerFilters ? filters.controls : null}
            <WindowControl />
          </>
        }
      />
      <WorkStats response={response} />
    </>
  )
}
