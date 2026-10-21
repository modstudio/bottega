import { BoardPage } from '@bottega/hub-site/board'
import { createFileRoute } from '@tanstack/react-router'
import { requireHostedSite, siteHead } from './-site'
export const Route = createFileRoute('/product/board')({
  beforeLoad: requireHostedSite,
  component: BoardPage,
  head: siteHead,
})
