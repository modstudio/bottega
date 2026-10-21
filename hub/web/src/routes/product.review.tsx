import { ReviewPage } from '@bottega/hub-site/review'
import { createFileRoute } from '@tanstack/react-router'
import { requireHostedSite, siteHead } from './-site'
export const Route = createFileRoute('/product/review')({
  beforeLoad: requireHostedSite,
  component: ReviewPage,
  head: siteHead,
})
