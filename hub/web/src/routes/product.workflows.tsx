import { createFileRoute } from '@tanstack/react-router'
import { WorkflowsPage } from '@/site/workflows'
import { requireHostedSite, siteHead } from './-site'
export const Route = createFileRoute('/product/workflows')({
  beforeLoad: requireHostedSite,
  component: WorkflowsPage,
  head: siteHead,
})
