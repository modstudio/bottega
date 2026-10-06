import { createFileRoute } from '@tanstack/react-router'
import { OrchestrationPage } from '@/site/pages'
import { requireHostedSite, siteHead } from '@/site/route'
export const Route = createFileRoute('/product/orchestration')({
  beforeLoad: requireHostedSite,
  component: OrchestrationPage,
  head: siteHead,
})
