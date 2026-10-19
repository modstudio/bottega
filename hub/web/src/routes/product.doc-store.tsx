import { DocStorePage } from '@bottega/hub-site/doc-store'
import { createFileRoute } from '@tanstack/react-router'
import { requireHostedSite, siteHead } from './-site'
export const Route = createFileRoute('/product/doc-store')({
  beforeLoad: requireHostedSite,
  component: DocStorePage,
  head: siteHead,
})
