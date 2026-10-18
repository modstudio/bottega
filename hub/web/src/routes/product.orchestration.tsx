import { createFileRoute } from '@tanstack/react-router'
import { OrchestrationPage } from '@/site/orchestration'
import { requireHostedSite, siteHead } from './-site'
export const Route = createFileRoute('/product/orchestration')({
  beforeLoad: requireHostedSite,
  component: OrchestrationPage,
  head: siteHead,
})
