import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { trpc } from './client.ts'
import { isHostedMode } from './hub-mode.ts'
import type { WindowInput } from './window-input.ts'

export function useBoard(input: WindowInput, paused: boolean) {
  const hosted = isHostedMode()
  const common = {
    placeholderData: keepPreviousData,
    refetchInterval: (paused ? false : 10_000) as false | number,
  }
  const remote = useQuery({ ...trpc.record.board.queryOptions(input), ...common, enabled: hosted })
  const local = useQuery({ ...trpc.work.board.queryOptions(input), ...common, enabled: !hosted })
  return hosted ? remote : local
}
