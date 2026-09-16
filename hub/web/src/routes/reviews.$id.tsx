import { createFileRoute, Navigate } from '@tanstack/react-router'
import { HostedReviewDetail } from '@/components/hosted-reviews'
import { isHostedMode } from '@/lib/hub-mode'

export const Route = createFileRoute('/reviews/$id')({
  component: function ReviewDetailPage() {
    const { id } = Route.useParams()
    if (!isHostedMode()) return <Navigate to="/" />
    return <HostedReviewDetail id={id} />
  },
})
