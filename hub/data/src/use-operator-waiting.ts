import { useQuery } from '@tanstack/react-query'
import { trpc } from './client.ts'
import { isHostedMode } from './hub-mode.ts'

export function useOperatorWaiting(enabled: boolean) {
  const hosted = isHostedMode()
  return useQuery({
    ...trpc.operator.waiting.queryOptions(undefined, { refetchInterval: 20_000 }),
    enabled: enabled && !hosted,
  })
}
