import { isHostedMode } from '@bottega/hub-data/hub-mode'
import { useHostedReview } from '@bottega/hub-data/use-reviews'
import { createFileRoute, Navigate } from '@tanstack/react-router'
import { HostedReviewDetail } from '@/routes/-review-lenses'

export const Route = createFileRoute('/reviews/$id')({
  component: function ReviewDetailPage() {
    const { id } = Route.useParams()
    if (!isHostedMode()) return <Navigate to="/" />
    return <HostedReviewDetailRoute id={id} />
  },
})

function HostedReviewDetailRoute({ id }: { id: string }) {
  return <HostedReviewDetail id={id} {...useHostedReview(id)} />
}
