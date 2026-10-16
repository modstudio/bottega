import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { createFileRoute } from '@tanstack/react-router'
import { HostedHealth } from '@/components/hosted-insights'
import { InsightView } from '@/components/insight-view'

export const Route = createFileRoute('/health')({
  component: () => (isHostedMode() ? <HostedHealth /> : <InsightView name="health" />),
})
