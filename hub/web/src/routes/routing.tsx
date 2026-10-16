import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { createFileRoute } from '@tanstack/react-router'
import { HostedRouting } from '@/components/hosted-insights'
import { InsightView } from '@/components/insight-view'

export const Route = createFileRoute('/routing')({
  component: () => (isHostedMode() ? <HostedRouting /> : <InsightView name="routing" />),
})
