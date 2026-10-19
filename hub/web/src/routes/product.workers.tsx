import { WorkersPage } from '@bottega/hub-site/workers'
import { createFileRoute } from '@tanstack/react-router'
import { requireHostedSite, siteHead } from './-site'
export const Route = createFileRoute('/product/workers')({
  beforeLoad: requireHostedSite,
  component: WorkersPage,
  head: siteHead,
})
