import { createFileRoute, Navigate } from '@tanstack/react-router'
import { HostedReviews } from '@/components/review-lenses'
import { isHostedMode } from '@/lib/hub-mode'

export const Route = createFileRoute('/reviews')({
  component: function ReviewsPage() {
    if (!isHostedMode()) return <Navigate to="/" />
    return <HostedReviews />
  },
})
