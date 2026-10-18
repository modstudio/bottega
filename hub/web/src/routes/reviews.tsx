import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { useHostedReviews } from '@bottega/hub-data/use-reviews'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import { HostedReviews } from '@/components/review-lenses'

export const Route = createFileRoute('/reviews')({
  component: function ReviewsPage() {
    if (!isHostedMode()) return <Navigate to="/" />
    return <HostedReviewsRoute />
  },
})

function HostedReviewsRoute() {
  return <HostedReviews {...useHostedReviews()} />
}
