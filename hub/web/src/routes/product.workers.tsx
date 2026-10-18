import { createFileRoute } from '@tanstack/react-router'
import { WorkersPage } from '@/site/workers'
import { requireHostedSite, siteHead } from './-site'
export const Route = createFileRoute('/product/workers')({
  beforeLoad: requireHostedSite,
  component: WorkersPage,
  head: siteHead,
})
