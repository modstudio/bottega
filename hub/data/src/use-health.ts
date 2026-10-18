import { useQuery } from '@tanstack/react-query'
import { trpc } from './client.ts'
import { isHostedMode } from './hub-mode.ts'
import type { WindowInput } from './window-input.ts'

export function useHealth(input: WindowInput, machineId: string | undefined) {
  const hosted = isHostedMode()
  const local = useQuery({
    ...trpc.insight.health.queryOptions(input, { refetchInterval: 30_000 }),
    enabled: !hosted,
  })
  const remote = useQuery({ ...trpc.record.health.queryOptions({ machineId }), enabled: hosted })
  return hosted
    ? {
        kind: 'hosted' as const,
        snapshot: remote.data ?? null,
        pending: remote.isPending,
        error: remote.error?.message ?? null,
      }
    : {
        kind: 'local' as const,
        response: local.data,
        pending: local.isPending,
        error: local.error?.message ?? null,
      }
}
