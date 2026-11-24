import type { HostedBoardRefresh } from './board-hosted-cache.ts'

export function hostedBoardRefreshStoppedReason(refresh: HostedBoardRefresh): string {
  if (refresh.reason) return refresh.reason.replace(/\s+/g, ' ')
  if (refresh.status === 'incomplete') return 'refresh did not catch up within its budget'
  return `refresh ${refresh.status}`
}

export const HOSTED_BOARD_PRODUCT_STOPPED_REMEDY = '; restore hosted record access and retry'
export const HOSTED_BOARD_SIDE_CHANNEL_STOPPED_REMEDY =
  '; notices stay queued for the next successful refresh'

export function hostedBoardStoppedMessage(
  surface: string,
  refresh: HostedBoardRefresh,
  remedy: string,
): string {
  return `hosted board ${surface} stopped: ${hostedBoardRefreshStoppedReason(refresh)}${remedy}`
}
