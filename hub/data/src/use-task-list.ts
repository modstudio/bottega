import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { trpc } from './client.ts'
import { isHostedMode } from './hub-mode.ts'
import type { WindowInput } from './window-input.ts'

type WorkName = 'flight' | 'done'

export function useTaskList(
  name: WorkName,
  input: WindowInput,
  paused: boolean,
  refetchInterval = 10_000,
) {
  const hosted = isHostedMode()
  const common = {
    placeholderData: keepPreviousData,
    refetchInterval: (paused ? false : refetchInterval) as false | number,
  }
  const hostedFlight = useQuery({
    ...trpc.record.flight.queryOptions(input),
    ...common,
    enabled: hosted && name === 'flight',
  })
  const hostedDone = useQuery({
    ...trpc.record.done.queryOptions(input),
    ...common,
    enabled: hosted && name === 'done',
  })
  const localFlight = useQuery({
    ...trpc.work.flight.queryOptions(input),
    ...common,
    enabled: !hosted && name === 'flight',
  })
  const localDone = useQuery({
    ...trpc.work.done.queryOptions(input),
    ...common,
    enabled: !hosted && name === 'done',
  })
  return hosted
    ? name === 'flight'
      ? hostedFlight
      : hostedDone
    : name === 'flight'
      ? localFlight
      : localDone
}
