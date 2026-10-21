import { WorkflowsPage } from '@bottega/hub-site/workflows'
import { createFileRoute } from '@tanstack/react-router'
import { requireHostedSite, siteHead } from './-site'
export const Route = createFileRoute('/product/workflows')({
  beforeLoad: requireHostedSite,
  component: WorkflowsPage,
  head: siteHead,
})
