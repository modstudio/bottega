import { collectedTime, relativeTime } from '@bottega/hub-util/format'

/** What every work page's response carries for its header and headline figures. */
export type ChromeResponse = {
  engaged: string
  activeAgents: string[]
  tasksShipped: number
  collectedAt: string | null
  servingSince: string
  counts: { flight: number; done: number; runs: number }
}

export function responseSubtitle(response: {
  collectedAt: string | null
  activeAgents: string[]
  servingSince: string
}) {
  const agent = `${response.activeAgents.length} agent${response.activeAgents.length === 1 ? '' : 's'} working`
  return {
    text: `${collectedTime(response.collectedAt)} \u00b7 ${agent}`,
    title: `Serving code from ${relativeTime(response.servingSince)}. ${response.activeAgents.length ? response.activeAgents.join(', ') : 'No agent on a task'}`,
  }
}
