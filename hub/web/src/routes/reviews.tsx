import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import { HostedReviews } from '@/components/review-lenses'

export const Route = createFileRoute('/reviews')({
  component: function ReviewsPage() {
    if (!isHostedMode()) return <Navigate to="/" />
    return <HostedReviews />
  },
})
