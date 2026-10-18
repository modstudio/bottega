import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { trpc } from './client.ts'
import { useHostedProjects } from './use-projects.ts'

type ReviewPage = NonNullable<ReturnType<typeof useReviewPage>['data']>

function useReviewPage(cursor: string | undefined) {
  return useQuery(trpc.record.reviews.queryOptions({ limit: 20, cursor }))
}

export function useHostedReviews() {
  const [pages, setPages] = useState<ReviewPage['items'][]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const { colors } = useHostedProjects()
  const query = useReviewPage(cursor)
  const applied = query.data
  const rows = applied
    ? cursor
      ? [...pages.flat(), ...applied.items]
      : applied.items
    : pages.flat()

  return {
    rows,
    colors,
    pending: query.isPending,
    loadMore: {
      run: () => {
        if (!applied?.nextCursor) return
        setPages((current) => [...current, applied.items])
        setCursor(applied.nextCursor ?? undefined)
      },
      pending: query.isFetching,
      error: query.error?.message ?? null,
      available: Boolean(applied?.nextCursor),
    },
  }
}

export function useHostedReview(id: string) {
  const detail = useQuery(trpc.record.review.queryOptions({ id }))
  const { colors } = useHostedProjects()
  return {
    review: detail.data ?? null,
    colors,
    pending: detail.isPending,
    error: detail.error?.message ?? null,
  }
}
