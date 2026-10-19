import { setWorkCounts } from '@bottega/hub-data/window'
import { PHONE_QUERY, useMediaQuery } from '@bottega/hub-ui/dom/use-media-query'
import { PageHeader } from '@bottega/hub-ui/page-header'
import { ToolbarBand } from '@bottega/hub-ui/toolbar-band'
import { type ChromeResponse, responseSubtitle } from '@bottega/hub-views/work-summary'
import { WorkStats } from '@bottega/hub-views/work-summary/work-stats'
import { type ReactNode, useEffect } from 'react'
import { useWindowFilters, WindowControl } from '@/routes/-window-controls'

type Facets = { projects: string[]; agents: string[]; sources: string[] }

type ChromeFigures = Pick<
  ChromeResponse,
  'engaged' | 'activeAgents' | 'tasksShipped' | 'collectedAt' | 'servingSince' | 'counts'
>

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
