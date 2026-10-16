import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import { HostedReviewDetail } from '@/components/review-lenses'

export const Route = createFileRoute('/reviews/$id')({
  component: function ReviewDetailPage() {
    const { id } = Route.useParams()
    if (!isHostedMode()) return <Navigate to="/" />
    return <HostedReviewDetail id={id} />
  },
})
