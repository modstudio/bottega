import { useQuery } from '@tanstack/react-query'
import { trpc } from './client.ts'

export function useHostedHealth(machineId: string | undefined) {
  const query = useQuery(trpc.record.health.queryOptions({ machineId }))
  return {
    snapshot: query.data ?? null,
    pending: query.isPending,
    error: query.error?.message ?? null,
  }
}
