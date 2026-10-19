import { type HostedReportScopeKind, useHostedReports } from '@bottega/hub-data/use-reports'
import { HostedReports } from '@bottega/hub-views/reports'
import { createFileRoute } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { WindowControl } from '@/components/design-system'
import { useWindowState } from '@/lib/window'

export const Route = createFileRoute('/reports')({ component: ReportsRoute })

function ReportsRoute() {
  const { hours } = useWindowState()
  const [kind, setKind] = useState<HostedReportScopeKind>('space')
  const [chosenProject, setChosenProject] = useState('')
  const [chosenPerson, setChosenPerson] = useState('')
  const window = useMemo(() => {
    const to = Date.now()
    return { from: new Date(to - hours * 3_600_000).toISOString(), to: new Date(to).toISOString() }
  }, [hours])
  const report = useHostedReports(window, { kind, chosenProject, chosenPerson })
  return (
    <HostedReports
      {...report}
      kind={kind}
      onKindChange={setKind}
      onProjectChange={setChosenProject}
      onPersonChange={setChosenPerson}
      windowControl={<WindowControl />}
    />
  )
}
