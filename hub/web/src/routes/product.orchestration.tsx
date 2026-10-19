import { OrchestrationPage } from '@bottega/hub-site/orchestration'
import { createFileRoute } from '@tanstack/react-router'
import { requireHostedSite, siteHead } from './-site'
export const Route = createFileRoute('/product/orchestration')({
  beforeLoad: requireHostedSite,
  component: OrchestrationPage,
  head: siteHead,
})
