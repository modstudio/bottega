import { ContextPage } from '@bottega/hub-site/context'
import { createFileRoute } from '@tanstack/react-router'
import { requireHostedSite, siteHead } from './-site'
export const Route = createFileRoute('/product/context')({
  beforeLoad: requireHostedSite,
  component: ContextPage,
  head: siteHead,
})
