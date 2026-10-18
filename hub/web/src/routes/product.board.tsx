import { createFileRoute } from '@tanstack/react-router'
import { BoardPage } from '@/site/board'
import { requireHostedSite, siteHead } from './-site'
export const Route = createFileRoute('/product/board')({
  beforeLoad: requireHostedSite,
  component: BoardPage,
  head: siteHead,
})
