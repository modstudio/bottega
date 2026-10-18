import { useQuery } from '@tanstack/react-query'
import { trpc } from './client.ts'
import { isHostedMode } from './hub-mode.ts'
import type { WindowInput } from './window-input.ts'

export function useRatio(input: WindowInput) {
  const hosted = isHostedMode()
  const local = useQuery({
    ...trpc.insight.ratio.queryOptions(input, { refetchInterval: 10_000 }),
    enabled: !hosted,
  })
  const remote = useQuery({
    ...trpc.record.ratio.queryOptions(
      { ...input, filters: { ...input.filters, source: '' } },
      { refetchInterval: 10_000 },
    ),
    enabled: hosted,
  })
  return hosted ? remote : local
}
